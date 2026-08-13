/**
 * Verifies the CDN validator's injected-environment boundary with a temporary
 * real manifest while mocking only the external CDN fetch.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { main } from "./validate-cdn-assets.mjs";

const temporaryRoots = [];

async function createFixtureRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), "eliza-cdn-env-test-"));
  temporaryRoots.push(root);

  const appPublic = path.join(root, "packages/app/public");
  const homepagePublic = path.join(root, "packages/homepage/public");
  const manifestPath = path.join(
    root,
    "scripts/generated/static-asset-manifest.json",
  );

  await Promise.all([
    mkdir(appPublic, { recursive: true }),
    mkdir(homepagePublic, { recursive: true }),
    mkdir(path.dirname(manifestPath), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(path.join(appPublic, "alpha.txt"), "alpha\n"),
    writeFile(path.join(appPublic, "beta.txt"), "beta\n"),
  ]);
  await writeFile(
    manifestPath,
    `${JSON.stringify(
      {
        app: ["packages/app/public/alpha.txt", "packages/app/public/beta.txt"],
        homepage: [],
      },
      null,
      2,
    )}\n`,
  );

  return root;
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await Promise.all(
    temporaryRoots.splice(0).map((root) =>
      rm(root, {
        recursive: true,
        force: true,
      }),
    ),
  );
});

describe("validate-cdn-assets injected environment", () => {
  it("uses the caller's retry concurrency instead of ambient process.env", async () => {
    const root = await createFixtureRoot();
    const originalAmbientConcurrency =
      process.env.ELIZA_CDN_VALIDATE_CONCURRENCY;
    process.env.ELIZA_CDN_VALIDATE_CONCURRENCY = "2";

    let activeRequests = 0;
    let maxActiveRequests = 0;
    vi.stubGlobal("fetch", async () => {
      activeRequests += 1;
      maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
      await new Promise((resolve) => setTimeout(resolve, 10));
      activeRequests -= 1;
      return { ok: true, status: 200 };
    });
    vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      await main({
        cwd: root,
        env: {
          GITHUB_SHA: "a".repeat(40),
          ELIZA_CDN_VALIDATION_REF: "injected-env-test",
          ELIZA_CDN_VALIDATE_CONCURRENCY: "1",
        },
      });
    } finally {
      if (originalAmbientConcurrency === undefined) {
        delete process.env.ELIZA_CDN_VALIDATE_CONCURRENCY;
      } else {
        process.env.ELIZA_CDN_VALIDATE_CONCURRENCY = originalAmbientConcurrency;
      }
    }

    expect(maxActiveRequests).toBe(1);
  });
});
