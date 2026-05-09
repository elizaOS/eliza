import fs, { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock(import("@elizaos/core"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    } as unknown as (typeof actual)["logger"],
  };
});

vi.mock(import("@elizaos/agent"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    resolveDefaultAgentWorkspaceDir: () => process.env.HOME ?? tmpdir(),
    resolveUserPath: (p: string) => p,
  };
});

import { _clearCompatPgliteDataDirForTests } from "./server";

const ORIGINAL_FETCH = globalThis.fetch;

describe("server reset hop (regression for #7409)", () => {
  let dataParent: string;
  let elizadb: string;

  beforeEach(() => {
    dataParent = mkdtempSync(join(tmpdir(), "eliza-reset-hop-"));
    elizadb = join(dataParent, ".elizadb");
    fs.mkdirSync(elizadb, { recursive: true });
    writeFileSync(join(elizadb, "marker"), "x");
  });

  afterEach(() => {
    rmSync(dataParent, { recursive: true, force: true });
    globalThis.fetch = ORIGINAL_FETCH;
    vi.restoreAllMocks();
  });

  it("stops the runtime and removes the .elizadb dir without issuing any HTTP requests", async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error("loopback fetch detected — would deadlock");
    });
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    const stop = vi.fn().mockResolvedValue(undefined);
    const runtime = { stop } as unknown as Parameters<
      typeof _clearCompatPgliteDataDirForTests
    >[0];

    const config = {
      database: { pglite: { dataDir: elizadb } },
    } as unknown as Parameters<typeof _clearCompatPgliteDataDirForTests>[1];

    const start = Date.now();
    await _clearCompatPgliteDataDirForTests(runtime, config);
    const elapsedMs = Date.now() - start;

    expect(stop).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(elizadb)).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(elapsedMs).toBeLessThan(2000);
  });

  it("refuses to delete an unexpected directory name (safety guard)", async () => {
    const wrongDir = join(dataParent, "not-elizadb");
    fs.mkdirSync(wrongDir, { recursive: true });
    writeFileSync(join(wrongDir, "marker"), "x");

    const config = {
      database: { pglite: { dataDir: wrongDir } },
    } as unknown as Parameters<typeof _clearCompatPgliteDataDirForTests>[1];

    await _clearCompatPgliteDataDirForTests(null, config);

    expect(fs.existsSync(wrongDir)).toBe(true);
  });

  it("tolerates a missing data dir (fresh state)", async () => {
    const missing = join(dataParent, "absent", ".elizadb");
    const config = {
      database: { pglite: { dataDir: missing } },
    } as unknown as Parameters<typeof _clearCompatPgliteDataDirForTests>[1];

    await expect(
      _clearCompatPgliteDataDirForTests(null, config),
    ).resolves.toBeUndefined();
  });
});
