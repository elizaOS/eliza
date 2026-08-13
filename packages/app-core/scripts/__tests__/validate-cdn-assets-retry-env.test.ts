/**
 * Regression for #18950: main({ env }) must forward the injected environment
 * into the retry-policy resolver. Drives the REAL main() against a hermetic
 * fixture root (tiny asset tree + manifest emitted by the real builder) with a
 * stubbed global fetch and a conflicting process.env, asserting the per-asset
 * attempt count comes from the injected env (2), not process.env (5) or the
 * CI default (3).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildStaticAssetManifest,
  STATIC_ASSET_MANIFEST_REPO_PATH,
  serializeStaticAssetManifest,
} from "../lib/static-asset-manifest.mjs";
import { main } from "../validate-cdn-assets.mjs";

describe("validate-cdn-assets retry policy env injection (#18950)", () => {
  let fixtureRoot: string;

  beforeEach(() => {
    fixtureRoot = mkdtempSync(path.join(tmpdir(), "cdn-retry-env-"));
    for (const asset of [
      "packages/app/public/asset-a.png",
      "packages/homepage/public/asset-b.png",
    ]) {
      const filePath = path.join(fixtureRoot, asset);
      mkdirSync(path.dirname(filePath), { recursive: true });
      writeFileSync(filePath, "png");
    }
    const manifestPath = path.join(
      fixtureRoot,
      STATIC_ASSET_MANIFEST_REPO_PATH,
    );
    mkdirSync(path.dirname(manifestPath), { recursive: true });
    writeFileSync(
      manifestPath,
      serializeStaticAssetManifest(buildStaticAssetManifest(fixtureRoot)),
    );
  });

  afterEach(() => {
    rmSync(fixtureRoot, { recursive: true, force: true });
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("honors the injected env's retry attempts over process.env", async () => {
    vi.stubEnv("ELIZA_CDN_VALIDATE_ATTEMPTS", "5");
    vi.stubEnv("CI", "true");
    const calls = new Map<string, number>();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown) => {
        const key = String(url);
        calls.set(key, (calls.get(key) ?? 0) + 1);
        // Retryable status so the policy's attempt count governs.
        return { ok: false, status: 503 } as Response;
      }),
    );
    const env = {
      ELIZA_RELEASE_TAG: "v0.0.0-test",
      ELIZA_CDN_VALIDATION_REF: "test-ref",
      ELIZA_CDN_VALIDATE_ATTEMPTS: "2",
      ELIZA_CDN_VALIDATE_DELAY_MS: "0",
      ELIZA_CDN_VALIDATE_CONCURRENCY: "2",
      CI: "false",
    };

    await expect(main({ cwd: fixtureRoot, env })).rejects.toThrow();

    // Both fixture assets probed, each exactly the injected 2 attempts —
    // not process.env's 5 and not the CI default 3 that pre-fix code
    // resolved from process.env.
    expect(calls.size).toBe(2);
    for (const [url, count] of calls) {
      expect(count, url).toBe(2);
    }
  });
});
