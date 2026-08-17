/**
 * Locks embedding boot invariants inside `eliza.ts`: canonical local identity
 * is pinned before warmup/probing, the provider-attested TEXT_EMBEDDING handler
 * is registered before the probe, and the probe precedes bundled-document
 * seeding. Deterministic and boot-free; no live runtime, model, or database.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * #8769 originally exposed this ordering when a provider returned a different
 * width. First-party providers now share one 384-dimensional BGE space, but the
 * order remains load-bearing: registration metadata establishes semantic-space
 * eligibility and reconciliation must complete before any document vectors are
 * written.
 */

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

  it("replaces stale same-width identity settings with canonical BGE settings", () => {
    const configureStart = elizaSource.indexOf(
      "export async function configureLocalEmbeddingPlugin(",
    );
    const configureEnd = elizaSource.indexOf(
      "export async function configureLocalEmbeddingEnvEarlyIfNeeded(",
      configureStart,
    );
    const configureBody = elizaSource.slice(configureStart, configureEnd);

    expect(configureBody).toContain(
      "process.env.LOCAL_EMBEDDING_MODEL = detectedPreset.model;",
    );
    expect(configureBody).toContain(
      "process.env.LOCAL_EMBEDDING_MODEL_REPO = detectedPreset.modelRepo;",
    );
    expect(configureBody).toContain(
      "process.env.TEXT_EMBEDDING_MODEL = CANONICAL_EMBEDDING_MODEL;",
    );
    expect(configureBody).toContain(
      "process.env.ELIZA_EMBED_POOLING = CANONICAL_EMBEDDING_POOLING;",
    );
    expect(configureBody).not.toContain(
      "findExistingEmbeddingModelForWarmupReuse",
    );
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

  it("probes the embedding dimension AFTER provider plugin waves register TEXT_EMBEDDING", () => {
    // ensureEmbeddingDimension() no-ops unless a TEXT_EMBEDDING model handler is
    // registered. Runtime attestation also requires the handler's canonical
    // semantic-space fingerprint, so the probe must run after plugin waves.
    expect(probeIdx).toBeGreaterThan(waveIdx);
  });

  it("probes the embedding dimension BEFORE seeding bundled documents (the #8769 fix)", () => {
    // Reconcile storage identity before any bundled-document vector is written.
    expect(probeIdx).toBeLessThan(seedIdx);
  });

  it("configures local-embedding env BEFORE the dimension probe (#16630 follow-up fix a)", () => {
    // Root cause: warmEmbeddingModel() (which owns configureLocalEmbeddingPlugin)
    // runs as deferred runtime-owned work AFTER this probe, so without an early
    // call EMBEDDING_PROVIDER is unset here and local ownership is ambiguous.
    // The early guarded config must therefore run before both the probe and the
    // bundled-document seed.
    expect(
      earlyLocalEnvIdx,
      "early local-embedding env config must run in runDeferredBoot",
    ).toBeGreaterThan(-1);
    expect(earlyLocalEnvIdx).toBeLessThan(probeIdx);
    expect(earlyLocalEnvIdx).toBeLessThan(seedIdx);
  });
});
