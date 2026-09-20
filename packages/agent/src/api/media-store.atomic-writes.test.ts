/**
 * Covers atomic persistence in the content-addressed media store: a short file
 * left under the correct hash by an interrupted write is rewritten instead of
 * reused, temporary siblings never survive a write, and a failed write leaves
 * neither the final name nor a temporary file behind. Runs the real module
 * against a temporary `ELIZA_STATE_DIR`; the failure case spies on one
 * `fs.writeSync` call and otherwise touches the real filesystem.
 */
import { Buffer } from "node:buffer";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

let stateDir: string;

beforeAll(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "media-store-atomic-"));
  process.env.ELIZA_STATE_DIR = stateDir;
});

afterAll(() => {
  fs.rmSync(stateDir, { recursive: true, force: true });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// Imported after env is set so resolveStateDir resolves to the temp dir.
const {
  persistMediaBytes,
  writeStoredMediaFile,
  handleMediaRouteRequest,
  gcUnreferencedMedia,
} = await import("./media-store.ts");

const PAYLOAD_BYTES = 4096;
const STALE_BYTES = 100;

function mediaDirPath(): string {
  return path.join(stateDir, "media");
}

function payload(seed: string): { bytes: Buffer; hash: string } {
  const bytes = Buffer.alloc(PAYLOAD_BYTES, seed);
  const hash = crypto.createHash("sha256").update(bytes).digest("hex");
  return { bytes, hash };
}

function seedTruncated(fileName: string): string {
  fs.mkdirSync(mediaDirPath(), { recursive: true });
  const filePath = path.join(mediaDirPath(), fileName);
  fs.writeFileSync(filePath, Buffer.alloc(STALE_BYTES, "x"));
  expect(fs.statSync(filePath).size).toBe(STALE_BYTES);
  return filePath;
}

function temporarySiblings(): string[] {
  return fs.readdirSync(mediaDirPath()).filter((name) => name.endsWith(".tmp"));
}

describe("media-store atomic writes", () => {
  it("rewrites a truncated file under the payload's hash on persist and serves the full bytes", () => {
    const { bytes, hash } = payload("a");
    const fileName = `${hash}.bin`;
    const filePath = seedTruncated(fileName);

    const stored = persistMediaBytes(bytes, "application/octet-stream");

    expect(stored.fileName).toBe(fileName);
    expect(fs.statSync(filePath).size).toBe(PAYLOAD_BYTES);
    expect(fs.readFileSync(filePath).equals(bytes)).toBe(true);
    const served = handleMediaRouteRequest(stored.url, "GET");
    expect(served.status).toBe(200);
    expect(served.body?.length).toBe(PAYLOAD_BYTES);
  });

  it("rewrites a truncated file under the restored name on the restore path", () => {
    const { bytes, hash } = payload("b");
    const fileName = `${hash}.bin`;
    const filePath = seedTruncated(fileName);

    expect(writeStoredMediaFile(fileName, bytes)).toBe(true);

    expect(fs.statSync(filePath).size).toBe(PAYLOAD_BYTES);
    expect(fs.readFileSync(filePath).equals(bytes)).toBe(true);
    const served = handleMediaRouteRequest(`/api/media/${fileName}`, "GET");
    expect(served.status).toBe(200);
    expect(served.body?.length).toBe(PAYLOAD_BYTES);
  });

  it("leaves no temporary sibling in the media directory after a persist", () => {
    const { bytes, hash } = payload("c");
    const stored = persistMediaBytes(bytes, "image/png");
    expect(stored.fileName).toBe(`${hash}.png`);
    expect(fs.existsSync(path.join(mediaDirPath(), stored.fileName))).toBe(
      true,
    );
    expect(temporarySiblings()).toEqual([]);
  });

  it("leaves neither the final name nor a temporary file when the write fails mid-way", () => {
    const { bytes, hash } = payload("d");
    const fileName = `${hash}.bin`;
    const filePath = path.join(mediaDirPath(), fileName);
    fs.mkdirSync(mediaDirPath(), { recursive: true });
    expect(fs.existsSync(filePath)).toBe(false);

    const enospc = Object.assign(new Error("no space left on device"), {
      code: "ENOSPC",
    });
    vi.spyOn(fs, "writeSync").mockImplementationOnce(() => {
      throw enospc;
    });

    expect(() => persistMediaBytes(bytes, "application/octet-stream")).toThrow(
      /no space left on device/,
    );

    expect(fs.existsSync(filePath)).toBe(false);
    expect(temporarySiblings()).toEqual([]);
  });

  it("garbage-collects a stranded temporary sibling past the grace window and keeps a fresh one", () => {
    const { hash } = payload("e");
    fs.mkdirSync(mediaDirPath(), { recursive: true });
    const stranded = path.join(
      mediaDirPath(),
      `${hash}.bin.4242.${"a".repeat(16)}.tmp`,
    );
    const inFlight = path.join(
      mediaDirPath(),
      `${hash}.bin.4243.${"b".repeat(16)}.tmp`,
    );
    fs.writeFileSync(stranded, Buffer.alloc(STALE_BYTES, "x"));
    fs.writeFileSync(inFlight, Buffer.alloc(STALE_BYTES, "y"));
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    fs.utimesSync(stranded, twoHoursAgo, twoHoursAgo);

    gcUnreferencedMedia(new Set());

    expect(fs.existsSync(stranded)).toBe(false);
    expect(fs.existsSync(inFlight)).toBe(true);
    fs.unlinkSync(inFlight);
  });
});
