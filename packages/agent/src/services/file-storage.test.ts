/**
 * Exercises LocalFileStorageService against a real on-disk media store rooted at
 * a temp `ELIZA_STATE_DIR` (no mocks): store, content-hash dedup, base64 data-URL
 * ingest, list metadata, existence, `getUrl`, and delete — including traversal-safe
 * rejection of malformed file names.
 */

import { Buffer } from "node:buffer";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let stateDir: string;

beforeAll(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "file-storage-test-"));
  process.env.ELIZA_STATE_DIR = stateDir;
});

afterAll(() => {
  fs.rmSync(stateDir, { recursive: true, force: true });
});

// Imported after env is set so the underlying media store resolves to the temp dir.
const { LocalFileStorageService } = await import("./file-storage.ts");

function svc() {
  return new LocalFileStorageService({ agentId: "agent-1" } as never);
}

describe("LocalFileStorageService", () => {
  it("stores bytes and returns a served handle", async () => {
    const out = await svc().store(Buffer.from("hello"), "text/plain");
    expect(out.url).toMatch(/^\/api\/media\/[a-f0-9]{64}\.txt$/);
    expect(out.mimeType).toBe("text/plain");
    expect(out.size).toBe(5);
    expect(out.hash).toHaveLength(64);
    expect(out.fileName.endsWith(".txt")).toBe(true);
  });

  it("dedups identical bytes (same hash + url)", async () => {
    const s = svc();
    const a = await s.store(Buffer.from("dup"), "image/png");
    const b = await s.store(Buffer.from("dup"), "image/png");
    expect(a.hash).toBe(b.hash);
    expect(a.url).toBe(b.url);
  });

  it("accepts a Uint8Array as well as a Buffer", async () => {
    const out = await svc().store(new Uint8Array([1, 2, 3, 4]), "audio/mpeg");
    expect(out.size).toBe(4);
    expect(out.url).toMatch(/\.mp3$/);
  });

  it("stores a base64 data URL", async () => {
    const dataUrl = `data:text/plain;base64,${Buffer.from("from-data").toString("base64")}`;
    const out = await svc().storeDataUrl(dataUrl);
    expect(out).not.toBeNull();
    expect(out?.mimeType).toBe("text/plain");
    expect(out?.size).toBe("from-data".length);
  });

  it("returns null for a non-data URL in storeDataUrl", async () => {
    expect(await svc().storeDataUrl("https://example.com/x.png")).toBeNull();
  });

  it("lists stored files with derived metadata", async () => {
    const s = svc();
    const stored = await s.store(
      Buffer.from("listme-unique-bytes"),
      "application/pdf",
    );
    const list = await s.list();
    const found = list.find((file) => file.fileName === stored.fileName);
    expect(found).toBeTruthy();
    expect(found?.mimeType).toBe("application/pdf");
    expect(found?.size).toBe("listme-unique-bytes".length);
    expect(typeof found?.createdAt).toBe("number");
  });

  it("reports existence + resolves getUrl, rejecting bad names (traversal-safe)", async () => {
    const s = svc();
    const stored = await s.store(Buffer.from("exists-me"), "text/plain");
    expect(await s.exists(stored.fileName)).toBe(true);
    expect(await s.exists("not-a-hash.txt")).toBe(false);
    expect(s.getUrl(stored.fileName)).toBe(stored.url);
    expect(s.getUrl("../../etc/passwd")).toBeNull();
  });

  it("deletes a stored file and rejects malformed names", async () => {
    const s = svc();
    const stored = await s.store(Buffer.from("delete-me"), "text/plain");
    expect(await s.delete(stored.fileName)).toBe(true);
    expect(await s.exists(stored.fileName)).toBe(false);
    expect(await s.delete("bad-name")).toBe(false);
  });
});
