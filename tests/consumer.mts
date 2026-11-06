import {
  createMetricRegistry,
  type MetricSchema,
  type MetricSchemas,
  type MetricLabels,
  type MetricUpdate,
  type MetricSnapshot,
  type RegistryOptions,
  type RecordResult,
  type MetricRegistry,
} from '@lp-labs/metric-registry';
const schemas = {
  requests: { kind: 'counter', unit: 'request', dimensions: { region: ['eu', 'us'] } },
  load: { kind: 'gauge', unit: 'ratio', dimensions: {} },
} as const satisfies MetricSchemas;
const schema: MetricSchema = schemas.requests;
const labels: MetricLabels<typeof schemas.requests> = { region: 'eu' };
const update: MetricUpdate<typeof schemas> = { name: 'requests', value: 1, labels };
const options: RegistryOptions = { maxSeries: 10, maxBatch: 10, overflow: 'drop' };
const registry: MetricRegistry<typeof schemas> = createMetricRegistry(schemas, options);
const result: RecordResult = registry.record(update);
registry.recordBatch([update]);
const snapshot: MetricSnapshot[] = registry.snapshot();
const size: number = registry.size;
// @ts-expect-error unknown metric name
registry.record({ name: 'missing', value: 1, labels: {} });
// @ts-expect-error enum dimension value is inferred
registry.record({ name: 'requests', value: 1, labels: { region: 'apac' } });
// @ts-expect-error required dimension
registry.record({ name: 'requests', value: 1, labels: {} });
// @ts-expect-error unexpected dimension
registry.record({ name: 'requests', value: 1, labels: { region: 'eu', extra: 'x' } });
void [schema, result, snapshot, size];
