export interface MetricSchema {
  kind: 'counter' | 'gauge';
  unit: string;
  dimensions: Readonly<Record<string, readonly string[]>>;
}
export type MetricSchemas = Readonly<Record<string, MetricSchema>>;
export type MetricLabels<T extends MetricSchema> = {
  [K in keyof T['dimensions']]: T['dimensions'][K][number];
};
export type MetricUpdate<S extends MetricSchemas> = {
  [K in keyof S & string]: { name: K; value: number; labels: MetricLabels<S[K]> };
}[keyof S & string];
export interface MetricSnapshot {
  name: string;
  kind: 'counter' | 'gauge';
  unit: string;
  labels: Record<string, string>;
  value: number;
}
export interface RegistryOptions {
  maxSeries?: number;
  maxBatch?: number;
  overflow?: 'throw' | 'drop';
}
export interface RecordResult {
  recorded: number;
  dropped: number;
}
export interface MetricRegistry<S extends MetricSchemas> {
  record(update: MetricUpdate<S>): RecordResult;
  recordBatch(updates: Iterable<MetricUpdate<S>>): RecordResult;
  snapshot(): MetricSnapshot[];
  readonly size: number;
}
function label(value: string): void {
  if (typeof value !== 'string' || !value || value.length > 128)
    throw new TypeError('Labels and units must contain 1–128 UTF-16 units.');
}
function capacity(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 100_000)
    throw new RangeError('Capacity must be between 1 and 100000.');
  return value;
}
export function createMetricRegistry<const S extends MetricSchemas>(
  input: S,
  options: RegistryOptions = {},
): MetricRegistry<S> {
  const maxSeries = capacity(options.maxSeries ?? 10_000),
    maxBatch = capacity(options.maxBatch ?? 10_000);
  const overflow = options.overflow ?? 'throw';
  if (overflow !== 'throw' && overflow !== 'drop') throw new TypeError('Unknown overflow policy.');
  const schemas = new Map<
    string,
    { kind: 'counter' | 'gauge'; unit: string; dimensions: Map<string, Set<string>> }
  >();
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new TypeError('Schemas must be a record.');
  const entries = Object.entries(input);
  if (!entries.length || entries.length > 1000)
    throw new RangeError('Expected 1–1000 metric schemas.');
  for (const [name, schema] of entries) {
    label(name);
    label(schema.unit);
    if (schema.kind !== 'counter' && schema.kind !== 'gauge')
      throw new TypeError('Unknown metric kind.');
    const dimensions = new Map<string, Set<string>>();
    if (
      !schema.dimensions ||
      typeof schema.dimensions !== 'object' ||
      Array.isArray(schema.dimensions)
    )
      throw new TypeError('Dimensions must be a record.');
    const dimensionEntries = Object.entries(schema.dimensions);
    if (dimensionEntries.length > 16) throw new RangeError('Maximum 16 dimensions.');
    for (const [key, values] of dimensionEntries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      label(key);
      if (!Array.isArray(values) || !values.length || values.length > 100)
        throw new RangeError('Expected 1–100 allowed dimension values.');
      for (const value of values) label(value);
      if (new Set(values).size !== values.length) throw new TypeError('Duplicate dimension value.');
      dimensions.set(key, new Set(values));
    }
    schemas.set(name, { kind: schema.kind, unit: schema.unit, dimensions });
  }
  let series = new Map<string, MetricSnapshot>();
  let recording = false;
  const recordBatch = (updates: Iterable<MetricUpdate<S>>): RecordResult => {
    if (recording) throw new Error('Reentrant registry mutation is not supported.');
    recording = true;
    try {
      const next = new Map(series);
      let recorded = 0,
        dropped = 0,
        count = 0;
      for (const update of updates) {
        if (++count > maxBatch) throw new RangeError('Batch capacity exceeded.');
        const name = update.name,
          increment = update.value,
          inputLabels = update.labels;
        const schema = schemas.get(name);
        if (!schema) throw new TypeError('Unknown metric.');
        if (typeof increment !== 'number' || !Number.isFinite(increment))
          throw new TypeError('Value must be finite.');
        if (schema.kind === 'counter' && increment < 0)
          throw new RangeError('Counters require nonnegative increments.');
        if (
          !inputLabels ||
          typeof inputLabels !== 'object' ||
          Array.isArray(inputLabels) ||
          Object.getOwnPropertyNames(inputLabels).length !== schema.dimensions.size ||
          Object.getOwnPropertySymbols(inputLabels).length !== 0
        )
          throw new TypeError('Dimensions must match the schema exactly.');
        const labels: Record<string, string> = Object.create(null) as Record<string, string>;
        for (const [key, allowed] of schema.dimensions) {
          const value = (inputLabels as Record<string, string>)[key];
          if (!Object.hasOwn(inputLabels, key) || !allowed.has(value!))
            throw new TypeError('Unknown dimension value or missing dimension.');
          labels[key] = value!;
        }
        const id = JSON.stringify([name, Object.entries(labels)]);
        const previous = next.get(id);
        if (!previous && next.size === maxSeries) {
          if (overflow === 'throw') throw new RangeError('Series cardinality exceeded.');
          dropped++;
          continue;
        }
        const value = schema.kind === 'counter' ? (previous?.value ?? 0) + increment : increment;
        if (!Number.isFinite(value)) throw new RangeError('Counter arithmetic overflow.');
        next.set(id, { name, kind: schema.kind, unit: schema.unit, labels, value });
        recorded++;
      }
      series = next;
      return { recorded, dropped };
    } finally {
      recording = false;
    }
  };
  return {
    get size() {
      return series.size;
    },
    record: (update) => recordBatch([update]),
    recordBatch,
    snapshot: () =>
      [...series.values()].map((entry) => ({ ...entry, labels: { ...entry.labels } })),
  };
}
