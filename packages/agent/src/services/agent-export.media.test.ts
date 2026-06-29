/**
 * Media capture/restore for the agent backup/export (#9963): the export now
 * bundles the content-addressed media bytes referenced by exported memories, so
 * a restored agent keeps its message images/attachments (the DB rows alone point
 * at media that wouldn't exist on the target).
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Content, Memory, UUID } from "@elizaos/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  readStoredMediaBytes,
  writeStoredMediaFile,
} from "../api/media-store.ts";
import { collectReferencedMediaFileNames } from "./agent-export.ts";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

function mem(content: Content): Memory {
  return {
    id: "00000000-0000-0000-0000-000000000001" as UUID,
    entityId: "00000000-0000-0000-0000-000000000002" as UUID,
    agentId: "00000000-0000-0000-0000-000000000003" as UUID,
    roomId: "00000000-0000-0000-0000-000000000004" as UUID,
    content,
    createdAt: 1,
  };
}

describe("collectReferencedMediaFileNames", () => {
  it("collects media file names from attachments and embedded text URLs, deduped", () => {
    const memories = [
      mem({ attachments: [{ id: "media-a", url: `/api/media/${SHA_A}.png` }] }),
      mem({ text: `see /api/media/${SHA_B}.jpg here` }),
      // duplicate of A via text — must dedupe
      mem({ text: `again /api/media/${SHA_A}.png` }),
    ];
    expect(collectReferencedMediaFileNames(memories).sort()).toEqual(
      [`${SHA_A}.png`, `${SHA_B}.jpg`].sort(),
    );
  });

  it("ignores non-stored and malformed URLs", () => {
    const memories = [
      mem({
        attachments: [{ id: "remote-cat", url: "https://example.com/cat.png" }],
      }),
      mem({ text: "no media here, just /api/media/short.png" }),
      mem({}),
    ];
    expect(collectReferencedMediaFileNames(memories)).toEqual([]);
  });
});

describe("media-store read/write round-trip", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "media-store-test-"));
    process.env.ELIZA_STATE_DIR = dir;
    process.env.MILADY_STATE_DIR = dir;
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes bytes by content-hash name and reads them back", () => {
    const bytes = Buffer.from("the webxr panels render now");
    const fileName = `${SHA_A}.bin`;
    expect(writeStoredMediaFile(fileName, bytes)).toBe(true);
    expect(readStoredMediaBytes(fileName)?.equals(bytes)).toBe(true);
    expect(readStoredMediaBytes(`${SHA_B}.bin`)).toBeNull(); // absent
  });

  it("refuses path traversal on both read and write", () => {
    expect(writeStoredMediaFile("../escape.bin", Buffer.from("x"))).toBe(false);
    expect(readStoredMediaBytes("../../etc/passwd")).toBeNull();
    expect(existsSync(join(dir, "..", "escape.bin"))).toBe(false);
  });
});
