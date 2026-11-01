/**
 * DiskStore.write must replace an entry atomically: a write that dies part way
 * (crash, ENOSPC, a second process writing the same key) must leave the
 * previous entry readable, never a truncated JSON row.
 */
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Simulate a write that dies after the first half of the bytes reached disk.
const crash = { next: false };
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const writeFileSync = ((
    file: Parameters<typeof actual.writeFileSync>[0],
    data: Parameters<typeof actual.writeFileSync>[1],
    options?: Parameters<typeof actual.writeFileSync>[2],
  ) => {
    if (crash.next && typeof file === "string" && typeof data === "string") {
      crash.next = false;
      actual.writeFileSync(file, data.slice(0, Math.floor(data.length / 2)));
      throw new Error("simulated crash mid-write");
    }
    return actual.writeFileSync(file, data, options);
  }) as typeof actual.writeFileSync;
  return {
    ...actual,
    writeFileSync,
    default: { ...actual, writeFileSync },
  };
});

const { DiskStore } = await import("./disk-store.ts");

function entry(key: string, value: string) {
  return {
    key,
    toolName: "probe",
    toolVersion: "1",
    cachedAt: 1,
    expiresAt: Number.MAX_SAFE_INTEGER,
    output: { value },
  };
}

describe("DiskStore atomic write", () => {
  let root: string;
  const key = "ab".padEnd(64, "0");

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "tool-cache-atomic-"));
    crash.next = false;
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("keeps the previous entry readable when a rewrite dies part way", () => {
    const store = new DiskStore(root, (output) => output);
    store.write(entry(key, "first"));

    crash.next = true;
    expect(() => store.write(entry(key, "second ".repeat(50)))).toThrow(
      "simulated crash mid-write",
    );

    // The interrupted rewrite never replaced the file: the old row still parses.
    expect(store.read(key)?.output).toEqual({ value: "first" });
    // And it left no temp file behind in the shard directory.
    expect(readdirSync(path.join(root, "ab"))).toEqual([`${key}.json`]);
  });

  it("round-trips an entry and stores it privately", () => {
    const store = new DiskStore(root, (output) => output);
    store.write(entry(key, "value"));
    expect(store.read(key)?.output).toEqual({ value: "value" });
    expect(readdirSync(path.join(root, "ab"))).toEqual([`${key}.json`]);
    if (process.platform !== "win32") {
      const mode = statSync(path.join(root, "ab", `${key}.json`)).mode & 0o777;
      expect(mode).toBe(0o600);
    }
  });
});
