/**
 * Locks the embedding-dimension boot ordering inside `runDeferredBoot`
 * (`eliza.ts`) for the managed cloud boot path: the dimension probe must run
 * after the deferred cloud plugin waves register the TEXT_EMBEDDING handler and
 * before bundled documents are seeded. Deterministic and boot-free — brace-
 * matches the closure out of `eliza.ts` source and reproduces the plugin-sql
 * insert guard with an in-memory fake adapter; no live runtime, model, or DB.
 * The regression rationale for the ordering is in the #8769 note below.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Regression coverage for #8769: managed cloud dedicated agents booted with NO
 * recall memory because `runtime.ensureEmbeddingDimension()` (the boot-time
 * embedding-dimension probe) ran AFTER `seedBundledDocumentsIfEnabled()`.
 *
 * The probe reads the registered cloud TEXT_EMBEDDING handler's vector length
 * (1536 on a managed agent) and snaps the plugin-sql storage column from its
 * hardcoded `dim384` default to `dim1536`. With the probe running too late, the
 * 4 bundled docs embedded at 1536 while the column was still `dim384`, so the
 * plugin-sql insert guard dropped every one of them:
 *   [PLUGIN:SQL] Skipping embedding insert: dimension mismatch
 *   (expectedDimension=384, receivedDimension=1536, column=dim384)
 * → no persistent memory.
 *
 * provisioning.test.ts in @elizaos/core exercises `provisioning.ts`'s
 * `ensureEmbeddingDimension`, which managed agents never run (they boot
 * `new AgentRuntime(...)` + `runtime.initialize()`, NOT
 * `createRuntimes({ provision: true })`). So that test is false coverage for
 * this bug. These tests cover the actual managed boot path instead:
 *   1. The source-order invariant inside `runDeferredBoot` in eliza.ts.
 *   2. The guard-level semantics the ordering protects.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const elizaSource = readFileSync(path.join(here, "eliza.ts"), "utf8");

/**
 * Slice out the body of the `runDeferredBoot` arrow closure so the ordering
 * assertions cannot be satisfied by an unrelated earlier/later occurrence of
 * the same identifier elsewhere in the (very large) eliza.ts file.
 */
function extractRunDeferredBootBody(source: string): string {
  const marker = "const runDeferredBoot = async (): Promise<void> => {";
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
});

/**
 * Behavioral coverage: a faithful mini-reproduction of the plugin-sql guard +
 * probe contract, driven through both boot orders to show WHY the ordering
 * matters at the storage layer. Mirrors BaseDrizzleAdapter:
 *   - embeddingDimension defaults to "dim384" (base.ts:297)
 *   - the insert guard drops a vector whose length !== the configured column
 *     width (base.ts:2383-2399)
 *   - ensureEmbeddingDimension(len) snaps the column via DIMENSION_MAP
 *     (base.ts:504-521)
 */
const DIMENSION_MAP: Record<number, string> = {
  384: "dim384",
  512: "dim512",
  768: "dim768",
  1024: "dim1024",
  1536: "dim1536",
  2048: "dim2048",
  3072: "dim3072",
};

class FakeSqlAdapter {
  // Matches BaseDrizzleAdapter's hardcoded default.
  embeddingDimension = "dim384";
  readonly persisted: number[][] = [];

  ensureEmbeddingDimension(length: number): void {
    const resolved = DIMENSION_MAP[length];
    if (resolved) this.embeddingDimension = resolved;
  }

  // Mirrors the insert guard at base.ts:2383-2399.
  insertMemoryEmbedding(vector: number[]): boolean {
    const expected = Number(this.embeddingDimension.replace(/^dim/, ""));
    if (vector.length !== expected) return false; // "Skipping embedding insert: dimension mismatch"
    this.persisted.push(vector);
    return true;
  }
}

const CLOUD_EMBEDDING_LENGTH = 1536;
const bundledDocVector = () => new Array(CLOUD_EMBEDDING_LENGTH).fill(0);

describe("embedding-dimension probe vs bundled-doc seed (guard semantics)", () => {
  it("DROPS 1536-dim bundled docs when the probe runs AFTER the seed (the #8769 bug)", () => {
    const adapter = new FakeSqlAdapter();

    // Old (buggy) order: seed first, probe second.
    const seededOk = adapter.insertMemoryEmbedding(bundledDocVector());
    adapter.ensureEmbeddingDimension(CLOUD_EMBEDDING_LENGTH);

    expect(seededOk).toBe(false);
    expect(adapter.persisted).toHaveLength(0); // no memory persisted
    // The column does eventually snap, but too late for the bundled docs.
    expect(adapter.embeddingDimension).toBe("dim1536");
  });

  it("PERSISTS 1536-dim bundled docs when the probe runs BEFORE the seed (the fix)", () => {
    const adapter = new FakeSqlAdapter();

    // New (fixed) order: probe first, seed second.
    adapter.ensureEmbeddingDimension(CLOUD_EMBEDDING_LENGTH);
    expect(adapter.embeddingDimension).toBe("dim1536");

    const seededOk = adapter.insertMemoryEmbedding(bundledDocVector());

    expect(seededOk).toBe(true);
    expect(adapter.persisted).toHaveLength(1); // bundled-doc memory persisted
  });
});
