import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { createMetricRegistry } from '../dist/esm/index.js';
const schemas = {
  requests: {
    kind: 'counter',
    unit: 'request',
    dimensions: { region: ['eu', 'us'], status: ['ok', 'error'] },
  },
  temperature: { kind: 'gauge', unit: 'celsius', dimensions: {} },
};
const update = (value, region = 'eu', status = 'ok') => ({
  name: 'requests',
  value,
  labels: { region, status },
});
test('bare CommonJS consumer matches ESM atomic counter/gauge snapshots', () => {
  const cjs = createRequire(import.meta.url)('@lp-labs/metric-registry');
  const esmRegistry = createMetricRegistry(schemas),
    cjsRegistry = cjs.createMetricRegistry(schemas);
  const updates = [update(1), update(3), { name: 'temperature', value: -1, labels: {} }];
  assert.deepEqual(cjsRegistry.recordBatch(updates), esmRegistry.recordBatch(updates));
  assert.deepEqual(cjsRegistry.snapshot(), esmRegistry.snapshot());
});
test('counter increments, gauge replaces, snapshot contains typed unit metadata', () => {
  const registry = createMetricRegistry(schemas);
  registry.record(update(2));
  registry.record(update(3));
  registry.record({ name: 'temperature', value: -5, labels: {} });
  registry.record({ name: 'temperature', value: 4, labels: {} });
  assert.equal(registry.size, 2);
  assert.deepEqual(registry.snapshot(), [
    {
      name: 'requests',
      kind: 'counter',
      unit: 'request',
      labels: { region: 'eu', status: 'ok' },
      value: 5,
    },
    { name: 'temperature', kind: 'gauge', unit: 'celsius', labels: {}, value: 4 },
  ]);
});
test('seeded bounded aggregation agrees with full rebuild oracle', () => {
  const registry = createMetricRegistry(schemas),
    oracle = new Map();
  let seed = 183;
  for (let i = 0; i < 1000; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const region = seed & 1 ? 'eu' : 'us',
      status = seed & 2 ? 'ok' : 'error',
      value = seed % 100;
    registry.record(update(value, region, status));
    const key = `${region}/${status}`;
    oracle.set(key, (oracle.get(key) ?? 0) + value);
  }
  for (const metric of registry.snapshot())
    assert.equal(metric.value, oracle.get(`${metric.labels.region}/${metric.labels.status}`));
});
test('dimension key ordering yields same series, and framing avoids collisions', () => {
  const registry = createMetricRegistry(schemas);
  registry.record(update(1));
  registry.record({ name: 'requests', value: 2, labels: { status: 'ok', region: 'eu' } });
  assert.equal(registry.size, 1);
  const framed = createMetricRegistry({
    x: { kind: 'counter', unit: 'u', dimensions: { a: ['x,y', 'x'], b: ['z', 'y,z'] } },
  });
  framed.record({ name: 'x', value: 1, labels: { a: 'x,y', b: 'z' } });
  framed.record({ name: 'x', value: 1, labels: { a: 'x', b: 'y,z' } });
  assert.equal(framed.size, 2);
});
test('throw cardinality policy rejects entire batch including earlier increments', () => {
  const registry = createMetricRegistry(schemas, { maxSeries: 1 });
  registry.record(update(2));
  assert.throws(() => registry.recordBatch([update(3), update(1, 'us')]), RangeError);
  assert.equal(registry.snapshot()[0].value, 2);
  assert.equal(registry.size, 1);
});
test('drop policy explicitly counts overflow and still updates existing series', () => {
  const registry = createMetricRegistry(schemas, { maxSeries: 1, overflow: 'drop' });
  assert.deepEqual(registry.recordBatch([update(1), update(2, 'us'), update(3)]), {
    recorded: 2,
    dropped: 1,
  });
  assert.equal(registry.snapshot()[0].value, 4);
  const before = registry.snapshot();
  assert.throws(() => registry.recordBatch([update(1), update(NaN, 'us')]), TypeError);
  assert.deepEqual(registry.snapshot(), before);
});
test('validation, arithmetic overflow and iterator failure are fully atomic', () => {
  const registry = createMetricRegistry(schemas);
  registry.record(update(1e308));
  assert.throws(() => registry.recordBatch([update(1), update(1e308)]), RangeError);
  const before = registry.snapshot();
  function* broken() {
    yield update(5);
    throw new Error('iterator');
  }
  assert.throws(() => registry.recordBatch(broken()), /iterator/);
  assert.deepEqual(registry.snapshot(), before);
  assert.throws(
    () => registry.recordBatch([update(1), { name: 'missing', labels: {}, value: 1 }]),
    TypeError,
  );
  assert.deepEqual(registry.snapshot(), before);
});
test('reentrant generator mutation cannot clobber concurrent state and releases guard', () => {
  const registry = createMetricRegistry(schemas);
  function* race() {
    yield update(1);
    registry.record(update(9));
    yield update(2);
  }
  assert.throws(() => registry.recordBatch(race()), /Reentrant/);
  assert.equal(registry.size, 0);
  registry.record(update(3));
  assert.equal(registry.snapshot()[0].value, 3);
});
test('schema, labels and snapshots are isolated from mutation races', () => {
  const schema = structuredClone(schemas),
    registry = createMetricRegistry(schema);
  schema.requests.dimensions.region.push('new');
  schema.requests.unit = 'changed';
  const input = update(1);
  registry.record(input);
  input.labels.region = 'us';
  const snapshot = registry.snapshot();
  snapshot[0].labels.region = 'mutated';
  snapshot[0].value = 99;
  assert.equal(registry.snapshot()[0].labels.region, 'eu');
  assert.equal(registry.snapshot()[0].unit, 'request');
  assert.equal(registry.snapshot()[0].value, 1);
  assert.throws(() => registry.record(update(1, 'new')), TypeError);
});
test('exact own dimensions, numeric values and counter sign are validated', () => {
  const registry = createMetricRegistry(schemas);
  for (const value of [NaN, Infinity, '1'])
    assert.throws(() => registry.record(update(value)), TypeError);
  assert.throws(() => registry.record(update(-1)), RangeError);
  for (const labels of [
    { region: 'eu' },
    { region: 'eu', status: 'ok', extra: 'x' },
    Object.create({ region: 'eu', status: 'ok' }),
  ])
    assert.throws(() => registry.record({ name: 'requests', value: 1, labels }), TypeError);
  assert.equal(registry.size, 0);
  const hidden = Object.defineProperty({ region: 'eu', status: 'ok' }, 'extra', { value: 'x' });
  const symbolic = { region: 'eu', status: 'ok', [Symbol('extra')]: 'x' };
  for (const labels of [hidden, symbolic])
    assert.throws(() => registry.record({ name: 'requests', value: 1, labels }), TypeError);
});
test('schema and batch capacities reject invalid inputs with atomic bounded iterator consumption', () => {
  assert.throws(() => createMetricRegistry({}), RangeError);
  assert.throws(() => createMetricRegistry([]), TypeError);
  assert.throws(
    () => createMetricRegistry({ x: { kind: 'gauge', unit: 'u', dimensions: [] } }),
    TypeError,
  );
  assert.throws(
    () => createMetricRegistry({ x: { kind: 'histogram', unit: 'u', dimensions: {} } }),
    TypeError,
  );
  assert.throws(
    () =>
      createMetricRegistry({ x: { kind: 'counter', unit: 'u', dimensions: { a: ['v', 'v'] } } }),
    TypeError,
  );
  assert.throws(() => createMetricRegistry(schemas, { maxSeries: 0 }), RangeError);
  assert.throws(() => createMetricRegistry(schemas, { overflow: 'evict' }), TypeError);
  const registry = createMetricRegistry(schemas, { maxBatch: 2 });
  let consumed = 0;
  function* infinite() {
    while (true) {
      consumed++;
      yield update(1);
    }
  }
  assert.throws(() => registry.recordBatch(infinite()), RangeError);
  assert.equal(consumed, 3);
  assert.equal(registry.size, 0);
});
