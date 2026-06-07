/**
 * Pure, dependency-free core logic for the embspec MCP server.
 *
 * Both the MCP request dispatcher (`src/server.ts`) and the unit tests
 * (`test/server.test.ts`) import from this module so there is a single
 * source of truth — the tests exercise exactly the code that ships, with
 * no duplicated re-implementations to drift out of sync.
 *
 * These functions re-implement the query-shaped surface of the Python
 * library at https://github.com/MukundaKatta/embspec natively in
 * TypeScript, so the MCP server has zero runtime dependencies beyond the
 * MCP SDK.
 */

/** How embedding vectors are normalized before they are indexed/queried. */
export type Normalization = 'l2' | 'none';

/**
 * The embedding configuration a vector index was built with, or that a
 * query encoder is about to use. Mirrors Python embspec's `EmbeddingSpec`.
 */
export interface EmbeddingSpec {
  /** Provider-qualified model identifier, e.g. `amazon.titan-embed-text-v2:0`. */
  model_id: string;
  /** Output dimensionality of the embedding vectors. */
  dimension: number;
  /** Optional model version pin. `undefined` is treated as `null`. */
  model_version?: string | null;
  /** Vector normalization scheme. Defaults to `'l2'` when omitted. */
  normalization?: Normalization;
}

/**
 * The on-disk manifest produced by Python embspec's
 * `IndexManifest.save()` (or constructed by hand). Records which embedding
 * spec a given index was built with.
 */
export interface ManifestJson {
  /** embspec on-disk schema version. Informational; not compared. */
  embspec_format_version?: number;
  /** Human-readable index identifier, echoed back in results. */
  index_name: string;
  /** The embedding spec the index was built with. */
  embedding: EmbeddingSpec;
}

/** A single field on which the query spec diverged from the manifest. */
export interface CompatibilityFailure {
  /** Dotted path of the offending field, e.g. `embedding.model_id`. */
  field: string;
  /** Value recorded in the index manifest. */
  manifest_value: unknown;
  /** Value the query encoder is using. */
  query_value: unknown;
}

/** Result of an {@link assertCompatible} check. */
export interface CompatibilityResult {
  /** `true` when the query spec exactly matches the manifest. */
  ok: boolean;
  /** Echo of `manifest.index_name`. */
  index_name: string;
  /** First (highest-precedence) mismatched field, when `ok` is `false`. */
  failed_field?: string;
  /** Manifest value of the first mismatch, when `ok` is `false`. */
  manifest_value?: unknown;
  /** Query value of the first mismatch, when `ok` is `false`. */
  query_value?: unknown;
  /** Every mismatch found, ordered by precedence, when `ok` is `false`. */
  all_failures?: CompatibilityFailure[];
  /** Human-readable message ready to surface to a user, when `ok` is `false`. */
  message?: string;
}

/** Result of a {@link neighborStability} comparison. */
export interface StabilityReport {
  /** Number of probe ids present in BOTH old and new results. */
  n_probes: number;
  /** The top-k cutoff that was applied. */
  k: number;
  /** Mean over probes of `|new ∩ old| / k`. */
  mean_overlap_at_k: number;
  /** Mean over probes of `|new ∩ old| / |new ∪ old|`. */
  mean_jaccard_at_k: number;
  /** Probe ids whose per-probe overlap fell below the regression threshold. */
  regression_probe_ids: string[];
  /** Convenience count, equal to `regression_probe_ids.length`. */
  regression_count: number;
  /**
   * Deploy-safety verdict. `true` only when `mean_overlap_at_k >= 0.85`
   * AND the regression fraction is `<= 0.05`, matching Python embspec's
   * `StabilityReport.is_safe_to_deploy()` defaults.
   */
  is_safe_to_deploy: boolean;
}

/**
 * Field precedence used both to decide which mismatch to report first and to
 * mirror the order in which Python embspec's `IndexManifest.assert_compatible`
 * raises: `model_id` > `dimension` > `model_version` > `normalization`.
 */
const FAILURE_ORDER = [
  'embedding.model_id',
  'embedding.dimension',
  'embedding.model_version',
  'embedding.normalization',
] as const;

/**
 * Compare a query encoder's {@link EmbeddingSpec} against the spec recorded
 * in an index {@link ManifestJson}.
 *
 * Compatibility is exact-match on `model_id`, `dimension`, `model_version`
 * (with `undefined` normalized to `null`), and `normalization` (with
 * `undefined` normalized to `'l2'`). Any divergence is a failure. This is
 * the fail-fast primitive that catches the silent-accuracy-collapse failure
 * mode where a query encoder upgrade ships before the index is re-encoded.
 *
 * @param manifest The index manifest the corpus was built with.
 * @param query The embedding spec the query encoder is about to use.
 * @returns A {@link CompatibilityResult}; `ok` is `true` on an exact match,
 *   otherwise `ok` is `false` with the highest-precedence offending field,
 *   the full ordered failure list, and a user-ready message.
 */
export function assertCompatible(
  manifest: ManifestJson,
  query: EmbeddingSpec,
): CompatibilityResult {
  const failures = compatibilityFailures(manifest.embedding, query);

  if (failures.length === 0) {
    return { ok: true, index_name: manifest.index_name };
  }

  const first = failures[0]!;
  return {
    ok: false,
    index_name: manifest.index_name,
    failed_field: first.field,
    manifest_value: first.manifest_value,
    query_value: first.query_value,
    all_failures: failures,
    message:
      `Index ${JSON.stringify(manifest.index_name)} manifest declares ` +
      `${first.field}=${JSON.stringify(first.manifest_value)} but query encoder ` +
      `uses ${JSON.stringify(first.query_value)}. ` +
      `Re-encode the corpus or roll the query encoder back.`,
  };
}

/**
 * Compute the ordered list of fields on which a query spec diverges from a
 * manifest embedding spec. Exported for callers that want every mismatch
 * without the wrapping {@link CompatibilityResult} (e.g. tests).
 *
 * @param manifestEmb The embedding spec recorded in the manifest.
 * @param query The embedding spec the query encoder is about to use.
 * @returns Mismatches ordered by {@link FAILURE_ORDER}; empty when compatible.
 */
export function compatibilityFailures(
  manifestEmb: EmbeddingSpec,
  query: EmbeddingSpec,
): CompatibilityFailure[] {
  const queryNorm = query.normalization ?? 'l2';
  const manifestNorm = manifestEmb.normalization ?? 'l2';
  const queryVer = query.model_version ?? null;
  const manifestVer = manifestEmb.model_version ?? null;

  const failures: CompatibilityFailure[] = [];

  if (queryVer !== manifestVer) {
    failures.push({
      field: 'embedding.model_version',
      manifest_value: manifestVer,
      query_value: queryVer,
    });
  }
  if (queryNorm !== manifestNorm) {
    failures.push({
      field: 'embedding.normalization',
      manifest_value: manifestNorm,
      query_value: queryNorm,
    });
  }
  if (query.dimension !== manifestEmb.dimension) {
    failures.push({
      field: 'embedding.dimension',
      manifest_value: manifestEmb.dimension,
      query_value: query.dimension,
    });
  }
  if (query.model_id !== manifestEmb.model_id) {
    failures.push({
      field: 'embedding.model_id',
      manifest_value: manifestEmb.model_id,
      query_value: query.model_id,
    });
  }

  failures.sort(
    (a, b) => FAILURE_ORDER.indexOf(a.field as never) - FAILURE_ORDER.indexOf(b.field as never),
  );

  return failures;
}

/** Thrown by {@link neighborStability} when an argument is out of range. */
export class StabilityArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StabilityArgumentError';
  }
}

/**
 * Compare two retrievers on a frozen probe set.
 *
 * Both `oldResults` and `newResults` map a probe id to that probe's ordered
 * top-k document ids. Only probe ids present in BOTH maps are scored; extras
 * in either map are ignored. For each common probe the top-`k` document ids
 * are compared as sets:
 *
 *   - overlap@k = `|new ∩ old| / k`
 *   - Jaccard@k = `|new ∩ old| / |new ∪ old|`
 *
 * A probe whose overlap@k falls below `regressionThreshold` is recorded as a
 * regression. The aggregate {@link StabilityReport} gates embedding-model
 * upgrades, chunker swaps, or rerank changes before deploy.
 *
 * @param oldResults Map of probe id -> old retriever's top-k doc ids.
 * @param newResults Map of probe id -> new retriever's top-k doc ids.
 * @param k Top-k cutoff. Must be `>= 1`. Defaults to `10`.
 * @param regressionThreshold Per-probe overlap below this counts as a
 *   regression. Must be in `[0, 1]`. Defaults to `0.5`.
 * @returns The aggregate {@link StabilityReport}.
 * @throws {StabilityArgumentError} If `k < 1` or `regressionThreshold` is
 *   outside `[0, 1]`.
 */
export function neighborStability(
  oldResults: Record<string, string[]>,
  newResults: Record<string, string[]>,
  k = 10,
  regressionThreshold = 0.5,
): StabilityReport {
  if (!Number.isFinite(k) || k < 1) {
    throw new StabilityArgumentError('neighbor_stability: k must be >= 1');
  }
  if (
    !Number.isFinite(regressionThreshold) ||
    regressionThreshold < 0 ||
    regressionThreshold > 1
  ) {
    throw new StabilityArgumentError(
      'neighbor_stability: regression_threshold must be in [0, 1]',
    );
  }

  const oldKeys = Object.keys(oldResults ?? {});
  const newKeys = new Set(Object.keys(newResults ?? {}));
  const common = oldKeys.filter((key) => newKeys.has(key)).sort();

  if (common.length === 0) {
    return {
      n_probes: 0,
      k,
      mean_overlap_at_k: 0,
      mean_jaccard_at_k: 0,
      regression_probe_ids: [],
      regression_count: 0,
      is_safe_to_deploy: false,
    };
  }

  let overlapSum = 0;
  let jaccardSum = 0;
  const regressions: string[] = [];

  for (const probeId of common) {
    const oldTopk = new Set((oldResults[probeId] ?? []).slice(0, k));
    const newTopk = new Set((newResults[probeId] ?? []).slice(0, k));
    let intersect = 0;
    for (const id of oldTopk) {
      if (newTopk.has(id)) intersect++;
    }
    const union = new Set([...oldTopk, ...newTopk]).size;
    const overlap = intersect / k;
    const jaccard = union > 0 ? intersect / union : 0;
    overlapSum += overlap;
    jaccardSum += jaccard;
    if (overlap < regressionThreshold) {
      regressions.push(probeId);
    }
  }

  const n = common.length;
  const meanOverlap = overlapSum / n;
  const meanJaccard = jaccardSum / n;
  const regressionFraction = regressions.length / n;
  const isSafe = meanOverlap >= 0.85 && regressionFraction <= 0.05;

  return {
    n_probes: n,
    k,
    mean_overlap_at_k: meanOverlap,
    mean_jaccard_at_k: meanJaccard,
    regression_probe_ids: regressions,
    regression_count: regressions.length,
    is_safe_to_deploy: isSafe,
  };
}
