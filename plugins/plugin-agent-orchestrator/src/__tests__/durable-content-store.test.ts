/**
 * Durable content store + projection: full content persisted content-addressed,
 * bounded views carry a resolvable reference, and the read API windows the
 * stored record losslessly. Real filesystem via the trajectory dir.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  durableProjection,
  persistDurableContent,
  readDurableContent,
} from "../services/durable-content-store.js";

let dir: string;
let savedEnv: string | undefined;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "durable-content-"));
  savedEnv = process.env.ELIZA_TRAJECTORY_DIR;
  process.env.ELIZA_TRAJECTORY_DIR = dir;
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env.ELIZA_TRAJECTORY_DIR;
  else process.env.ELIZA_TRAJECTORY_DIR = savedEnv;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("durable content store", () => {
  it("persists content-addressed and reads back windows losslessly", () => {
    const text = "0123456789".repeat(100);
    const ref = persistDurableContent(text);
    expect(ref.ref).toMatch(/^acpx-content:[0-9a-f]{64}$/);
    const sha = ref.ref.slice("acpx-content:".length);

    const head = readDurableContent(sha, { offset: 0, limit: 100 });
    expect(head?.text.length).toBe(100);
    expect(head?.hasMore).toBe(true);
    expect(head?.totalBytes).toBe(1000);

    // Lossless reassembly across windows.
    let out = "";
    let offset = 0;
    for (;;) {
      const window = readDurableContent(sha, { offset, limit: 333 });
      if (!window) throw new Error("record vanished");
      out += window.text;
      if (!window.hasMore) break;
      offset = window.offset + Buffer.byteLength(window.text, "utf8");
    }
    expect(out).toBe(text);

    // Idempotent persist.
    expect(persistDurableContent(text).ref).toBe(ref.ref);
  });

  it("returns undefined for unknown or malformed refs", () => {
    expect(readDurableContent("f".repeat(64))).toBeUndefined();
    expect(readDurableContent("not-a-sha")).toBeUndefined();
    expect(readDurableContent("../escape")).toBeUndefined();
  });

  it("a projection under budget passes through without persisting", () => {
    const projection = durableProjection("short", 100);
    expect(projection).toEqual({ view: "short", truncated: false });
  });

  it("an oversized projection persists first and names the resolver route", () => {
    const text = "x".repeat(5000);
    const projection = durableProjection(text, 300);
    expect(projection.truncated).toBe(true);
    expect(projection.view.length).toBeLessThanOrEqual(300);
    expect(projection.view).toContain("/api/orchestrator/content/");
    const sha = projection.reference?.ref.slice("acpx-content:".length) ?? "";
    // The marker's promise is real: the complete record resolves.
    const window = readDurableContent(sha, { limit: 10_000 });
    expect(window?.text).toBe(text);
    expect(projection.read?.slice.completeness).toBe("partial-recoverable");
    expect(projection.read?.slice.hasMore).toBe(true);
  });
});
