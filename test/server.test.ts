/**
 * Unit tests against the same tool functions exposed by the MCP server.
 *
 * These don't spin up a full stdio server (the SDK harness for that is
 * heavyweight); instead they cover the same JSON-shaped functions the
 * server's request dispatcher calls, mirroring the agentcast-mcp
 * test pattern.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

// Re-import the same logic. Since the server builds the tool dispatcher
// inline, we duplicate the small pure functions here for testing.
// In a v0.2 we'd factor them into a shared module.

interface ManifestJson {
  embspec_format_version?: number;
  index_name: string;
  embedding: {
    model_id: string;
    dimension: number;
    model_version?: string | null;
    normalization?: 'l2' | 'none';
  };
}

function assertCompatible(
  manifest: ManifestJson,
  query: ManifestJson['embedding'],
) {
  const m = manifest.embedding;
  const failures: Array<{
    field: string;
    manifest_value: unknown;
    query_value: unknown;
  }> = [];

  if ((query.model_version ?? null) !== (m.model_version ?? null)) {
    failures.push({
      field: 'embedding.model_version',
      manifest_value: m.model_version ?? null,
      query_value: query.model_version ?? null,
    });
  }
  if ((query.normalization ?? 'l2') !== (m.normalization ?? 'l2')) {
    failures.push({
      field: 'embedding.normalization',
      manifest_value: m.normalization ?? 'l2',
      query_value: query.normalization ?? 'l2',
    });
  }
  if (query.dimension !== m.dimension) {
    failures.push({
      field: 'embedding.dimension',
      manifest_value: m.dimension,
      query_value: query.dimension,
    });
  }
  if (query.model_id !== m.model_id) {
    failures.push({
      field: 'embedding.model_id',
      manifest_value: m.model_id,
      query_value: query.model_id,
    });
  }

  failures.sort((a, b) => {
    const order = [
      'embedding.model_id',
      'embedding.dimension',
      'embedding.model_version',
      'embedding.normalization',
    ];
    return order.indexOf(a.field) - order.indexOf(b.field);
  });

  return failures;
}

function neighborStability(
  oldRes: Record<string, string[]>,
  newRes: Record<string, string[]>,
  k = 10,
  regressionThreshold = 0.5,
) {
  const oldKeys = Object.keys(oldRes);
  const newKeys = new Set(Object.keys(newRes));
  const common = oldKeys.filter((k2) => newKeys.has(k2)).sort();

  if (common.length === 0) {
    return {
      n_probes: 0,
      k,
      mean_overlap_at_k: 0,
      mean_jaccard_at_k: 0,
      regression_probe_ids: [],
      is_safe_to_deploy: false,
    };
  }

  let overlapSum = 0;
  let jaccardSum = 0;
  const regressions: string[] = [];

  for (const probeId of common) {
    const oldTopk = new Set(oldRes[probeId]!.slice(0, k));
    const newTopk = new Set(newRes[probeId]!.slice(0, k));
    let intersect = 0;
    for (const id of oldTopk) {
      if (newTopk.has(id)) intersect++;
    }
    const union = new Set([...oldTopk, ...newTopk]).size;
    const overlap = intersect / k;
    const jaccard = union > 0 ? intersect / union : 0;
    overlapSum += overlap;
    jaccardSum += jaccard;
    if (overlap < regressionThreshold) regressions.push(probeId);
  }

  const n = common.length;
  const meanOverlap = overlapSum / n;
  const regressionFraction = regressions.length / n;
  return {
    n_probes: n,
    k,
    mean_overlap_at_k: meanOverlap,
    mean_jaccard_at_k: jaccardSum / n,
    regression_probe_ids: regressions,
    is_safe_to_deploy: meanOverlap >= 0.85 && regressionFraction <= 0.05,
  };
}

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

test('assert_compatible: identical specs return no failures', () => {
  const failures = assertCompatible(baseManifest, baseManifest.embedding);
  assert.equal(failures.length, 0);
});

test('assert_compatible: model_id mismatch is reported first', () => {
  const failures = assertCompatible(baseManifest, {
    ...baseManifest.embedding,
    model_id: 'openai:text-embedding-3-small',
  });
  assert.ok(failures.length >= 1);
  assert.equal(failures[0]!.field, 'embedding.model_id');
});

test('assert_compatible: dimension mismatch reported when model matches', () => {
  const failures = assertCompatible(baseManifest, {
    ...baseManifest.embedding,
    dimension: 1536,
  });
  assert.equal(failures[0]!.field, 'embedding.dimension');
});

test('assert_compatible: model_version mismatch reported', () => {
  const failures = assertCompatible(baseManifest, {
    ...baseManifest.embedding,
    model_version: 'v2',
  });
  assert.equal(failures[0]!.field, 'embedding.model_version');
});

test('assert_compatible: normalization mismatch reported', () => {
  const failures = assertCompatible(baseManifest, {
    ...baseManifest.embedding,
    normalization: 'none',
  });
  assert.equal(failures[0]!.field, 'embedding.normalization');
});

test('assert_compatible: model_id wins precedence over dimension', () => {
  const failures = assertCompatible(baseManifest, {
    model_id: 'other',
    dimension: 9999,
    model_version: null,
    normalization: 'l2',
  });
  assert.equal(failures[0]!.field, 'embedding.model_id');
  assert.ok(failures.length >= 2);
});

// --- neighbor_stability --------------------------------------------------

test('neighbor_stability: identical results give perfect overlap', () => {
  const docs = ['a', 'b', 'c'];
  const old = { q1: docs, q2: docs };
  const r = neighborStability(old, old, 3);
  assert.equal(r.mean_overlap_at_k, 1.0);
  assert.equal(r.mean_jaccard_at_k, 1.0);
  assert.equal(r.is_safe_to_deploy, true);
  assert.equal(r.regression_probe_ids.length, 0);
});

test('neighbor_stability: disjoint results give zero overlap', () => {
  const r = neighborStability(
    { q1: ['a', 'b'] },
    { q1: ['c', 'd'] },
    2,
  );
  assert.equal(r.mean_overlap_at_k, 0);
  assert.equal(r.mean_jaccard_at_k, 0);
  assert.equal(r.is_safe_to_deploy, false);
  assert.deepEqual(r.regression_probe_ids, ['q1']);
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
});

test('neighbor_stability: truncates to k when results are longer', () => {
  const r = neighborStability(
    { q1: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] },
    { q1: ['a', 'b', 'z', 'y', 'x', 'w', 'v'] },
    2,
  );
  assert.equal(r.mean_overlap_at_k, 1.0);
});
