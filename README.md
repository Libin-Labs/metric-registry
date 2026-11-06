# @lp-labs/metric-registry

Typed counter/gauge schemas with enumerated dimensions, bounded live cardinality,
and explicit atomic batch/overflow semantics. Original independent implementation,
zero runtime/peer dependencies, Node >=18, version 0.1.0.

```sh
npm install @lp-labs/metric-registry
```

## Runnable example

```js
import { createMetricRegistry } from '@lp-labs/metric-registry';

const registry = createMetricRegistry(
  {
    requests: { kind: 'counter', unit: 'request', dimensions: { region: ['eu', 'us'] } },
    load: { kind: 'gauge', unit: 'ratio', dimensions: {} },
  },
  { maxSeries: 3, maxBatch: 10, overflow: 'throw' },
);
registry.record({ name: 'requests', value: 1, labels: { region: 'eu' } });
const result = registry.recordBatch([
  { name: 'requests', value: 2, labels: { region: 'eu' } },
  { name: 'load', value: 0.5, labels: {} },
]);
if (result.recorded !== 2 || registry.snapshot()[0].value !== 3)
  throw new Error('Unexpected metrics');
console.log(registry.snapshot());
```

CommonJS: `require('@lp-labs/metric-registry')`. The factory is the sole runtime export;
ESM and CommonJS declarations expose all named types below.

## API and types

- `MetricSchema`: `kind: 'counter' | 'gauge'`, `unit: string`,
  `dimensions: Readonly<Record<string, readonly string[]>>`, enumerated allowed values.
- `MetricSchemas`: readonly metric-name-to-schema record.
- `MetricLabels<T extends MetricSchema>`: maps each dimension key to its allowed
  string literal union; use `as const satisfies MetricSchemas` to retain literal types.
- `MetricUpdate<S extends MetricSchemas>`: discriminated union of `{ name, value, labels }`
  correlated with each schema. Unknown names/values/missing or extra dimensions are
  checked at runtime, too. An empty dimension type is `{}` in TypeScript and cannot
  statically reject every extra key; runtime exactness still applies.
- `RegistryOptions`: `maxSeries` (default 10000), `maxBatch` (default 10000),
  `overflow: 'throw' | 'drop'` (default `'throw'`). Positive safe-integer limits <=100000.
- `RecordResult`: `{ recorded: number; dropped: number }`, counts update operations,
  not distinct series.
- `MetricSnapshot`: `name`, `kind`, `unit`, `labels: Record<string, string>`, `value`.
- `createMetricRegistry<const S extends MetricSchemas>(schemas: S, options?: RegistryOptions): MetricRegistry<S>`.
  Copies schemas and allowed values at construction.
- `MetricRegistry<S>.record(update: MetricUpdate<S>): RecordResult`: one atomic update.
- `recordBatch(updates: Iterable<MetricUpdate<S>>): RecordResult`: atomic ordered batch.
  Counter adds a nonnegative finite increment (initial zero), gauge replaces with any
  finite number. Repeated series updates occur in iterator order. No async iterable.
- `snapshot(): MetricSnapshot[]`: isolated copies in first-seen series insertion order.
- `size`: number of live distinct series. Identity is metric name plus canonical
  dimension-name order and values, JSON-framed to avoid delimiter collisions.

Example type usage: declare schemas `as const satisfies MetricSchemas`, then call
`createMetricRegistry(schemas)`. `MetricLabels<typeof schemas.requests>` and
`MetricUpdate<typeof schemas>` retain dimension literals. Widening schemas to a
general record loses literal checking but never runtime validation.

## Errors, overflow and atomicity

`TypeError`: nonrecord schemas/dimensions, invalid kind, empty/nonstrings/over-128-UTF-16-unit metric/unit/dimension
labels, duplicate allowed dimension values, unknown metrics, nonfinite values,
missing/extra/inherited/symbol dimension keys, disallowed dimension values, or unknown policy.
`RangeError`: nonpositive/out-of-range capacities, 0 or >1000 schemas, >16 dimensions
per schema, 0 or >100 values per dimension, negative counter increments, counter
arithmetic overflow, overlong batches, or throw-policy cardinality overflow.

All batch changes are staged and committed only when iteration and validation complete.
Any error, including iterator/getter errors, leaves registry state unchanged. In
`'drop'` mode only valid updates creating a new series at capacity are dropped; updates
to existing series still apply. Invalid updates are **never silently dropped**.
Dropped operations reserve no cardinality and create no overflow/aggregate series.
Subsequent validation errors roll back earlier staged updates and drops; no result
is returned. A batch consumes at most maxBatch + 1 items before rejection.

Reentrant mutation (for example, a generator calling `record` while being consumed)
throws `Error` and cannot overwrite concurrent state. Guard resets even on failure.
Read snapshots during iteration show only previously committed data. There is no
multi-worker/shared-memory coordination; synchronous atomicity only.

## Customization and limitations

Choose bounded dimension enums, live-series limit, batch size, overflow policy,
counter/gauge kinds and units. Units are metadata only; no conversion is performed.
High-dimensional products can be huge, but only observed series allocate storage;
`maxSeries` bounds live cardinality. No deletion, reset, histograms, timestamps, rates,
labels inferred from users, exporters, remote telemetry, statistical guarantees or
automatic aggregation of dropped data. Counters use IEEE-754 numbers, not exact large
integers. Avoid sensitive dimension values; this is not a privacy/access boundary.

Storage O(S + schema data), batch staging O(S + B), each batch copies the live map;
one-record calls therefore have O(S) staging cost, plus at most 16 dimension checks.
Config/input objects should be ordinary trusted data; nonterminating getters/iterators
and caller code are outside execution bounds.
Related design context: virtual-time deterministic order, performance-budgets honest
numeric checks, incremental-aggregation atomic snapshots, unit-system explicit units.
No shared code or runtime imports.

## Development

`npm run build`, `npm run typecheck`, `npm test`, `npm run format`, `npm run format:check`.
Dev-only TypeScript ^5.9.3 and Prettier ^3.6.2, strict ESM/CommonJS declaration builds.
Tests cover seeded rebuild oracles, staged overflow rollback, iterator/reentrancy races,
mutation isolation, canonical dimensions, and bounded cardinality.

## Support

If this library is useful to you, consider supporting its maintenance with a [donation via PayPal](https://www.paypal.me/LibinPrasanth).

## Author

Created by [Libin Prasanth](https://www.linkedin.com/in/libinprasanth/). Connect on LinkedIn for updates and discussion.
