/**
 * Unit tests for the embspec MCP server's core logic.
 *
 * These import the SAME functions the server's request dispatcher calls
 * (from `../src/core.ts`) rather than re-implementing them, so the tests
 * exercise exactly the code that ships. There are no duplicated copies to
 * drift out of sync.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  assertCompatible,
  compatibilityFailures,
  neighborStability,
  StabilityArgumentError,
  type ManifestJson,
} from '../src/core.ts';

const baseManifest: ManifestJson = {
  embspec_format_version: 1,
  index_name: 'prod-v3',
  embedding: {
    model_id: 'amazon.titan-embed-text-v2:0',
    dimension: 1024,
    model_version: null,
    normalization: 'l2',
  },
};

// --- assert_compatible ---------------------------------------------------

test('assert_compatible: identical specs are compatible', () => {
  const r = assertCompatible(baseManifest, baseManifest.embedding);
  assert.equal(r.ok, true);
  assert.equal(r.index_name, 'prod-v3');
  assert.equal(r.all_failures, undefined);
  assert.equal(r.message, undefined);
});

test('assert_compatible: model_id mismatch is reported first', () => {
  const r = assertCompatible(baseManifest, {
    ...baseManifest.embedding,
    model_id: 'openai:text-embedding-3-small',
  });
  assert.equal(r.ok, false);
  assert.equal(r.failed_field, 'embedding.model_id');
  assert.equal(r.manifest_value, 'amazon.titan-embed-text-v2:0');
  assert.equal(r.query_value, 'openai:text-embedding-3-small');
  assert.ok(r.message && r.message.includes('prod-v3'));
});

test('assert_compatible: dimension mismatch reported when model matches', () => {
  const r = assertCompatible(baseManifest, {
    ...baseManifest.embedding,
    dimension: 1536,
  });
  assert.equal(r.ok, false);
  assert.equal(r.failed_field, 'embedding.dimension');
  assert.equal(r.manifest_value, 1024);
  assert.equal(r.query_value, 1536);
});

test('assert_compatible: model_version mismatch reported', () => {
  const r = assertCompatible(baseManifest, {
    ...baseManifest.embedding,
    model_version: 'v2',
  });
  assert.equal(r.ok, false);
  assert.equal(r.failed_field, 'embedding.model_version');
});

test('assert_compatible: normalization mismatch reported', () => {
  const r = assertCompatible(baseManifest, {
    ...baseManifest.embedding,
    normalization: 'none',
  });
  assert.equal(r.ok, false);
  assert.equal(r.failed_field, 'embedding.normalization');
});

test('assert_compatible: omitted normalization defaults to l2', () => {
  // Manifest l2, query omits normalization -> treated as l2 -> compatible.
  const r = assertCompatible(baseManifest, {
    model_id: baseManifest.embedding.model_id,
    dimension: baseManifest.embedding.dimension,
    model_version: null,
  });
  assert.equal(r.ok, true);
});

test('assert_compatible: omitted model_version is treated as null', () => {
  const r = assertCompatible(baseManifest, {
    model_id: baseManifest.embedding.model_id,
    dimension: baseManifest.embedding.dimension,
    // model_version omitted -> null -> matches manifest null
    normalization: 'l2',
  });
  assert.equal(r.ok, true);
});

test('assert_compatible: model_id wins precedence over dimension', () => {
  const r = assertCompatible(baseManifest, {
    model_id: 'other',
    dimension: 9999,
    model_version: null,
    normalization: 'l2',
  });
  assert.equal(r.failed_field, 'embedding.model_id');
  assert.ok(r.all_failures && r.all_failures.length >= 2);
});

test('compatibilityFailures: returns all mismatches in precedence order', () => {
  const failures = compatibilityFailures(baseManifest.embedding, {
    model_id: 'other',
    dimension: 1,
    model_version: 'v9',
    normalization: 'none',
  });
  assert.deepEqual(
    failures.map((f) => f.field),
    [
      'embedding.model_id',
      'embedding.dimension',
      'embedding.model_version',
      'embedding.normalization',
    ],
  );
});

// --- neighbor_stability --------------------------------------------------

test('neighbor_stability: identical results give perfect overlap', () => {
  const docs = ['a', 'b', 'c'];
  const old = { q1: docs, q2: docs };
  const r = neighborStability(old, old, 3);
  assert.equal(r.mean_overlap_at_k, 1.0);
  assert.equal(r.mean_jaccard_at_k, 1.0);
  assert.equal(r.is_safe_to_deploy, true);
  assert.equal(r.regression_count, 0);
  assert.deepEqual(r.regression_probe_ids, []);
});

test('neighbor_stability: disjoint results give zero overlap', () => {
  const r = neighborStability({ q1: ['a', 'b'] }, { q1: ['c', 'd'] }, 2);
  assert.equal(r.mean_overlap_at_k, 0);
  assert.equal(r.mean_jaccard_at_k, 0);
  assert.equal(r.is_safe_to_deploy, false);
  assert.deepEqual(r.regression_probe_ids, ['q1']);
  assert.equal(r.regression_count, 1);
});

test('neighbor_stability: partial overlap metrics correct', () => {
  const r = neighborStability(
    { q1: ['a', 'b', 'c', 'd', 'e'] },
    { q1: ['a', 'b', 'x', 'y', 'z'] },
    5,
  );
  assert.equal(r.mean_overlap_at_k, 0.4);
  assert.equal(r.mean_jaccard_at_k, 2 / 8);
});

test('neighbor_stability: only intersecting probe ids counted', () => {
  const r = neighborStability(
    { q1: ['a'], q2: ['b'] },
    { q2: ['b'], q3: ['c'] },
    1,
  );
  assert.equal(r.n_probes, 1);
});

test('neighbor_stability: empty inputs return zero report', () => {
  const r = neighborStability({}, {}, 5);
  assert.equal(r.n_probes, 0);
  assert.equal(r.is_safe_to_deploy, false);
  assert.equal(r.regression_count, 0);
});

test('neighbor_stability: truncates to k when results are longer', () => {
  const r = neighborStability(
    { q1: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] },
    { q1: ['a', 'b', 'z', 'y', 'x', 'w', 'v'] },
    2,
  );
  assert.equal(r.mean_overlap_at_k, 1.0);
});

test('neighbor_stability: default k is 10', () => {
  const r = neighborStability({ q1: ['a'] }, { q1: ['a'] });
  assert.equal(r.k, 10);
  // 1 hit out of k=10 -> overlap 0.1.
  assert.equal(r.mean_overlap_at_k, 0.1);
});

test('neighbor_stability: regression_threshold flags borderline probes', () => {
  // overlap@k = 2/4 = 0.5 with k=4. threshold 0.6 -> regression; 0.5 -> not.
  const old = { q1: ['a', 'b', 'c', 'd'] };
  const neu = { q1: ['a', 'b', 'x', 'y'] };
  const flagged = neighborStability(old, neu, 4, 0.6);
  assert.deepEqual(flagged.regression_probe_ids, ['q1']);
  const notFlagged = neighborStability(old, neu, 4, 0.5);
  assert.deepEqual(notFlagged.regression_probe_ids, []);
});

test('neighbor_stability: rejects k < 1', () => {
  assert.throws(
    () => neighborStability({ q1: ['a'] }, { q1: ['a'] }, 0),
    StabilityArgumentError,
  );
});

test('neighbor_stability: rejects out-of-range regression_threshold', () => {
  assert.throws(
    () => neighborStability({ q1: ['a'] }, { q1: ['a'] }, 5, 1.5),
    StabilityArgumentError,
  );
  assert.throws(
    () => neighborStability({ q1: ['a'] }, { q1: ['a'] }, 5, -0.1),
    StabilityArgumentError,
  );
});

test('neighbor_stability: is_safe_to_deploy needs >=0.85 overlap', () => {
  // 9/10 of 10 probes perfect, 1 probe disjoint -> mean overlap 0.9 but the
  // regression fraction is 0.1 (> 0.05) so it is NOT safe.
  const old: Record<string, string[]> = {};
  const neu: Record<string, string[]> = {};
  for (let i = 0; i < 9; i++) {
    old['q' + i] = ['a'];
    neu['q' + i] = ['a'];
  }
  old['q9'] = ['a'];
  neu['q9'] = ['z'];
  const r = neighborStability(old, neu, 1);
  assert.equal(r.mean_overlap_at_k, 0.9);
  assert.equal(r.regression_count, 1);
  assert.equal(r.is_safe_to_deploy, false);
});
