import { readFileSync } from "node:fs";
import path from "node:path";
import {
  closePgliteSingleton,
  getPgliteSingletonCache,
} from "@elizaos/plugin-sql";
import { afterEach, describe, expect, it } from "vitest";
import { resetPluginSqlPgliteSingleton } from "./pglite-auto-reset";

/**
 * The app-core DB auto-reset (invoked by attemptPgliteAutoReset when a corrupt
 * `.elizadb` dir is detected) must recover the PGlite singleton through
 * plugin-sql's PUBLIC closePgliteSingleton() API — not by hand-copying the
 * plugin's private global-singletons Symbol. These tests
 * seed and inspect the singleton exclusively via the exported
 * getPgliteSingletonCache() accessor, proving the seam is real.
 */
describe("resetPluginSqlPgliteSingleton (app-core DB auto-reset)", () => {
  const originalPgliteDataDir = process.env.PGLITE_DATA_DIR;

  afterEach(async () => {
    // Leave no manager behind for other suites sharing the process-global cache.
    await closePgliteSingleton();
    if (originalPgliteDataDir === undefined) {
      delete process.env.PGLITE_DATA_DIR;
    } else {
      process.env.PGLITE_DATA_DIR = originalPgliteDataDir;
    }
  });

  it("closes and drops the active PGlite manager through the exported API", async () => {
    const cache = getPgliteSingletonCache();
    let closed = false;
    cache.pgLiteClientManager = {
      isShuttingDown: () => false,
      close: async () => {
        closed = true;
      },
    };

    await resetPluginSqlPgliteSingleton("test auto-reset");

    expect(closed).toBe(true);
    expect(cache.pgLiteClientManager).toBeUndefined();
  });

  it("is a no-op when no PGlite singleton is present", async () => {
    const cache = getPgliteSingletonCache();
    delete cache.pgLiteClientManager;

    await expect(
      resetPluginSqlPgliteSingleton("test auto-reset"),
    ).resolves.toBeUndefined();

    expect(cache.pgLiteClientManager).toBeUndefined();
  });

  it("still drops the manager when close() rejects", async () => {
    const cache = getPgliteSingletonCache();
    let closeCalled = false;
    cache.pgLiteClientManager = {
      isShuttingDown: () => false,
      close: async () => {
        closeCalled = true;
        throw new Error("close boom");
      },
    };

    await resetPluginSqlPgliteSingleton("test auto-reset");

    expect(closeCalled).toBe(true);
    expect(cache.pgLiteClientManager).toBeUndefined();
  });

  it("keys runtime PGlite recovery on plugin-sql's exported error codes", () => {
    const source = readFileSync(
      path.resolve(import.meta.dirname, "eliza.ts"),
      "utf8",
    );

    expect(source).toContain(
      'import { PGLITE_ERROR_CODES } from "@elizaos/plugin-sql";',
    );
    expect(source).toContain("PGLITE_ERROR_CODES.MANUAL_RESET_REQUIRED");
    expect(source).toContain("PGLITE_ERROR_CODES.CORRUPT_DATA");
    expect(source).not.toContain("ELIZA_AUTO_RESET_PGLITE_ERROR_CODE");
    expect(source).not.toContain('"ELIZA_PGLITE_MANUAL_RESET_REQUIRED"');
  });
});
