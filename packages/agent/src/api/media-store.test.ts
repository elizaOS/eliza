import { Buffer } from "node:buffer";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  gcUnreferencedMedia,
  persistMediaBytes,
  readStoredMediaBytes,
  storedMediaFileExists,
  writeStoredMediaFile,
} from "./media-store.ts";

const previousStateDir = process.env.ELIZA_STATE_DIR;
let stateDir: string;

beforeAll(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "media-store-atomic-"));
  process.env.ELIZA_STATE_DIR = stateDir;
});

afterAll(() => {
  fs.rmSync(stateDir, { recursive: true, force: true });
  if (previousStateDir === undefined) delete process.env.ELIZA_STATE_DIR;
  else process.env.ELIZA_STATE_DIR = previousStateDir;
});

describe("media-store atomic writes", () => {
  it("rewrites a truncated content-addressed file and leaves no pending files", () => {
    const bytes = Buffer.from("complete media payload bytes");
    const { fileName } = persistMediaBytes(bytes, "application/octet-stream");
    const mediaDir = path.join(stateDir, "media");
    fs.writeFileSync(path.join(mediaDir, fileName), bytes.subarray(0, 5));

    persistMediaBytes(bytes, "application/octet-stream");

    expect(readStoredMediaBytes(fileName)).toEqual(bytes);
    expect(
      fs.readdirSync(mediaDir).filter((name) => name.startsWith(".pending-")),
    ).toEqual([]);
  });

  it("restores over a truncated file", () => {
    const bytes = Buffer.from("restored media payload bytes");
    const { fileName } = persistMediaBytes(bytes, "application/octet-stream");
    fs.writeFileSync(path.join(stateDir, "media", fileName), "");

    expect(writeStoredMediaFile(fileName, bytes)).toBe(true);
    expect(readStoredMediaBytes(fileName)).toEqual(bytes);
  });
});

describe("media-store size cap", () => {
  it("evicts only files the last GC sweep saw as unreferenced", () => {
    const previousCap = process.env.ELIZA_MEDIA_STORE_MAX_BYTES;
    process.env.ELIZA_MEDIA_STORE_MAX_BYTES = "3000";
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const mediaDir = path.join(stateDir, "media");
      for (const name of fs.readdirSync(mediaDir)) {
        fs.rmSync(path.join(mediaDir, name), { force: true });
      }
      // A knowledge original (still referenced) and an old chat file nobody
      // references, both 30 minutes old: inside the GC grace window.
      const original = persistMediaBytes(
        Buffer.alloc(1500, 1),
        "application/pdf",
      ).fileName;
      const orphan = persistMediaBytes(
        Buffer.alloc(1000, 2),
        "application/octet-stream",
      ).fileName;
      const halfHourAgo = new Date(Date.now() - 30 * 60_000);
      fs.utimesSync(path.join(mediaDir, original), halfHourAgo, halfHourAgo);
      fs.utimesSync(
        path.join(mediaDir, orphan),
        new Date(halfHourAgo.getTime() + 1000),
        new Date(halfHourAgo.getTime() + 1000),
      );
      gcUnreferencedMedia(new Set([original]));

      // A new attachment after the sweep pushes the store over the cap.
      vi.setSystemTime(Date.now() + 60_000);
      const fresh = persistMediaBytes(
        Buffer.alloc(1000, 3),
        "application/octet-stream",
      ).fileName;

      expect(storedMediaFileExists(original)).toBe(true);
      expect(storedMediaFileExists(fresh)).toBe(true);
      expect(storedMediaFileExists(orphan)).toBe(false);
    } finally {
      vi.useRealTimers();
      if (previousCap === undefined)
        delete process.env.ELIZA_MEDIA_STORE_MAX_BYTES;
      else process.env.ELIZA_MEDIA_STORE_MAX_BYTES = previousCap;
    }
  });
});
