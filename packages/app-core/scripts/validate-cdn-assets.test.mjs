/**
 * Verifies CDN validation retry-policy resolution against injected
 * environments: `getValidationRetryPolicy` defaults and overrides, and that
 * `main({ env })` builds its retry policy from the supplied env rather than
 * `process.env`. Deterministic and offline — network is stubbed via
 * `globalThis.fetch` over a real temporary manifest fixture (#18634).
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeStaticAssetManifest } from "./lib/static-asset-manifest.mjs";
import { getValidationRetryPolicy, main } from "./validate-cdn-assets.mjs";

const POLICY_ENV_KEYS = [
  "ELIZA_CDN_VALIDATE_ATTEMPTS",
  "ELIZA_CDN_VALIDATE_DELAY_MS",
  "ELIZA_CDN_VALIDATE_CONCURRENCY",
  "CI",
];
const savedProcessEnv = new Map(
  POLICY_ENV_KEYS.map((key) => [key, process.env[key]]),
);
const temporaryDirectories = [];

afterEach(() => {
  for (const [key, value] of savedProcessEnv) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  for (const dir of temporaryDirectories.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("getValidationRetryPolicy", () => {
  it("uses local defaults when overrides are unset or empty", () => {
    expect(getValidationRetryPolicy({ env: {} })).toEqual({
      attempts: 1,
      delayMs: 0,
      concurrency: 2,
    });
    expect(
      getValidationRetryPolicy({
        env: {
          ELIZA_CDN_VALIDATE_ATTEMPTS: "",
          ELIZA_CDN_VALIDATE_DELAY_MS: "",
          ELIZA_CDN_VALIDATE_CONCURRENCY: "",
        },
      }),
    ).toEqual({ attempts: 1, delayMs: 0, concurrency: 2 });
  });

  it("uses CI defaults when the injected env sets CI=true", () => {
    expect(getValidationRetryPolicy({ env: { CI: "true" } })).toEqual({
      attempts: 3,
      delayMs: 5000,
      concurrency: 4,
    });
  });

  it("honors explicit overrides from the injected env", () => {
    expect(
      getValidationRetryPolicy({
        env: {
          ELIZA_CDN_VALIDATE_ATTEMPTS: "5",
          ELIZA_CDN_VALIDATE_DELAY_MS: "0",
          ELIZA_CDN_VALIDATE_CONCURRENCY: "7",
        },
      }),
    ).toEqual({ attempts: 5, delayMs: 0, concurrency: 7 });
  });

  it("ignores process.env when an env is injected", () => {
    process.env.ELIZA_CDN_VALIDATE_ATTEMPTS = "9";
    process.env.CI = "true";
    expect(getValidationRetryPolicy({ env: {} })).toEqual({
      attempts: 1,
      delayMs: 0,
      concurrency: 2,
    });
    expect(getValidationRetryPolicy().attempts).toBe(9);
  });
});

describe("main({ env }) retry-policy plumbing", () => {
  function createManifestFixture() {
    const root = mkdtempSync(path.join(os.tmpdir(), "eliza-cdn-validate-"));
    temporaryDirectories.push(root);
    const appPublic = path.join(root, "packages/app/public");
    mkdirSync(appPublic, { recursive: true });
    writeFileSync(path.join(appPublic, "asset.txt"), "fixture");
    writeStaticAssetManifest(root);
    return root;
  }

  it("probes assets with the injected policy, not process.env", async () => {
    const root = createManifestFixture();
    // The plumbing bug this guards against: main() building its policy from
    // process.env. Give process.env a 1-attempt policy and the injected env a
    // 3-attempt policy — the observed probe count tells us which one won.
    process.env.ELIZA_CDN_VALIDATE_ATTEMPTS = "1";
    delete process.env.CI;

    let assetProbes = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url) => {
        if (String(url).endsWith("/package.json")) {
          return { ok: true, status: 200 };
        }
        assetProbes += 1;
        return { ok: false, status: 503 };
      }),
    );
    const exitError = new Error("process.exit(1)");
    vi.spyOn(process, "exit").mockImplementation(() => {
      throw exitError;
    });
    vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      main({
        cwd: root,
        env: {
          ELIZA_RELEASE_TAG: "v0.0.0-test",
          ELIZA_CDN_VALIDATE_ATTEMPTS: "3",
          ELIZA_CDN_VALIDATE_DELAY_MS: "0",
          ELIZA_CDN_VALIDATE_CONCURRENCY: "1",
        },
      }),
    ).rejects.toBe(exitError);

    expect(process.exit).toHaveBeenCalledWith(1);
    expect(assetProbes).toBe(3);
  });
});
