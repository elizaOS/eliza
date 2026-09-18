/**
 * Checks source ordering for embedding configuration, dimension probing, and
 * document seeding in the managed boot path. These guards do not execute host
 * startup or prove that the SQL adapter persists an embedding.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const elizaSource = readFileSync(path.join(here, "eliza.ts"), "utf8");

describe("early local embedding ownership policy", () => {
  const start = elizaSource.indexOf(
    "export async function configureLocalEmbeddingEnvEarlyIfNeeded(",
  );
  const end = elizaSource.indexOf(
    "// ---------------------------------------------------------------------------",
    start,
  );
  const body = elizaSource.slice(start, end);

  it("does not confuse packaged prefetch skipping with remote provider ownership", () => {
    expect(start).toBeGreaterThan(-1);
    expect(body).toContain("shouldUseLocalEmbeddingModel");
    expect(body).not.toContain("shouldWarmupLocalEmbeddingModel");
  });
});

describe("deferred local embedding warmup canonical capability gate", () => {
  const start = elizaSource.indexOf("const startEmbeddingWarmup = async (");
  const end = elizaSource.indexOf(
    "// Per-agent EVM + Solana wallet bootstrap",
    start,
  );
  const body = elizaSource.slice(start, end);

  it("returns before touching the local model when canonical routing omits embeddings", () => {
    expect(start).toBeGreaterThan(-1);
    const canonicalGate = body.indexOf(
      'runtime.getSetting(\n      "ELIZA_CANONICAL_EMBEDDINGS_ENABLED",',
    );
    const warmupCall = body.indexOf("await warmEmbeddingModel(abortSignal);");
    expect(canonicalGate).toBeGreaterThan(-1);
    expect(body).toContain("canonicalEmbeddings === false");
    expect(canonicalGate).toBeLessThan(warmupCall);
  });
});

/**
 * Slice out the body of the `runDeferredBoot` arrow closure so the ordering
 * assertions cannot be satisfied by an unrelated earlier/later occurrence of
 * the same identifier elsewhere in the (very large) eliza.ts file.
 */
function extractRunDeferredBootBody(source: string): string {
  const marker = "const runDeferredBoot = async (";
  const start = source.indexOf(marker);
  expect(
    start,
    "runDeferredBoot closure must exist in eliza.ts",
  ).toBeGreaterThan(-1);

  // Walk braces from the opening `{` to find the matching close.
  let depth = 0;
  let i = source.indexOf("{", start);
  const bodyStart = i;
  for (; i < source.length; i++) {
    const ch = source[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return source.slice(bodyStart, i + 1);
    }
  }
  throw new Error("Could not find end of runDeferredBoot closure");
}

describe("runDeferredBoot embedding-dimension ordering (#8769)", () => {
  const body = extractRunDeferredBootBody(elizaSource);

  // Match the awaited CALL statements, not comment mentions, so a doc comment
  // that names a later step cannot skew the ordering indices.
  const waveIdx = body.indexOf(
    "await preregisterCorePluginsInDependencyWaves({",
  );
  const earlyLocalEnvIdx = body.indexOf(
    "await configureLocalEmbeddingEnvEarlyIfNeeded(config);",
  );
  const probeIdx = body.indexOf("await runtime.ensureEmbeddingDimension();");
  const seedIdx = body.indexOf("await seedBundledDocumentsIfEnabled();");

  it("calls all three boot steps inside runDeferredBoot", () => {
    expect(waveIdx, "deferred core-plugin waves must run").toBeGreaterThan(-1);
    expect(probeIdx, "embedding-dimension probe must run").toBeGreaterThan(-1);
    expect(seedIdx, "bundled-document seed must run").toBeGreaterThan(-1);
  });

  it("probes the embedding dimension AFTER the cloud plugin waves register the TEXT_EMBEDDING handler", () => {
    // ensureEmbeddingDimension() no-ops unless a TEXT_EMBEDDING model handler is
    // registered; the cloud handler (plugin-elizacloud) is registered by the
    // deferred core-plugin waves, so the probe must run after them.
    expect(probeIdx).toBeGreaterThan(waveIdx);
  });

  it("probes the embedding dimension BEFORE seeding bundled documents (the #8769 fix)", () => {
    // This is the invariant the fix establishes: the storage column is snapped
    // to dim1536 before any bundled-doc embedding is written, so the inserts are
    // not dropped on a dimension mismatch.
    expect(probeIdx).toBeLessThan(seedIdx);
  });

  it("configures local-embedding env BEFORE the dimension probe (#16630 follow-up fix a)", () => {
    // Root cause: warmEmbeddingModel() (which owns configureLocalEmbeddingPlugin)
    // runs as deferred runtime-owned work AFTER this probe, so without an early
    // call EMBEDDING_PROVIDER is unset here and a remote handler (e.g. Google
    // text-embedding-004) wins the probe and 404s, permanently choosing the
    // remote route. The early guarded config must therefore run before both the
    // probe and the bundled-doc seed.
    expect(
      earlyLocalEnvIdx,
      "early local-embedding env config must run in runDeferredBoot",
    ).toBeGreaterThan(-1);
    expect(earlyLocalEnvIdx).toBeLessThan(probeIdx);
    expect(earlyLocalEnvIdx).toBeLessThan(seedIdx);
  });
});
