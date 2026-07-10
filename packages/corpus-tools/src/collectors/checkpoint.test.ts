/**
 * Collector checkpoint tests. Verifies the resume marker round-trips atomically,
 * treats a first run (no file) as null, and fails closed on a corrupted marker
 * rather than silently restarting a backfill from zero.
 */
import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readCheckpoint, writeCheckpoint } from "./checkpoint.ts";

async function stateDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "signal-checkpoint-"));
}

describe("collector checkpoint", () => {
  it("returns null before any checkpoint is written", async () => {
    const dir = await stateDir();
    expect(await readCheckpoint(dir, "signal", "primary")).toBeNull();
  });

  it("round-trips a checkpoint", async () => {
    const dir = await stateDir();
    await writeCheckpoint(dir, {
      platform: "signal",
      accountId: "primary",
      lastTs: 1_720_000_000_000,
      lastId: "signal:primary:m9",
      messageCount: 42,
      updatedAt: new Date().toISOString(),
    });
    const loaded = await readCheckpoint(dir, "signal", "primary");
    expect(loaded?.lastTs).toBe(1_720_000_000_000);
    expect(loaded?.lastId).toBe("signal:primary:m9");
    expect(loaded?.messageCount).toBe(42);
  });

  it("leaves no temp file after an atomic write", async () => {
    const dir = await stateDir();
    await writeCheckpoint(dir, {
      platform: "signal",
      accountId: "primary",
      lastTs: 1,
      messageCount: 1,
      updatedAt: new Date().toISOString(),
    });
    const entries = await readdir(path.join(dir, "signal"));
    expect(entries.some((name) => name.endsWith(".tmp"))).toBe(false);
  });

  it("fails closed on a corrupt checkpoint", async () => {
    const dir = await stateDir();
    const file = path.join(dir, "signal", "primary.checkpoint.json");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, '{"platform":"signal"}', "utf8");
    await expect(readCheckpoint(dir, "signal", "primary")).rejects.toThrow(
      /corrupt checkpoint/,
    );
  });
});
