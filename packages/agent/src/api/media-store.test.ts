import { Buffer } from "node:buffer";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  persistMediaBytes,
  readStoredMediaBytes,
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
