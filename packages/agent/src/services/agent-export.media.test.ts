/**
 * Media capture/restore for the agent backup/export (#9963): the export now
 * bundles the content-addressed media bytes referenced by exported memories, so
 * a restored agent keeps its message images/attachments (the DB rows alone point
 * at media that wouldn't exist on the target).
 */
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Content, Memory, UUID } from "@elizaos/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  readStoredMediaBytes,
  storedMediaContentMatchesName,
  writeStoredMediaFile,
} from "../api/media-store.ts";
import {
  collectReferencedMediaFileNames,
  restoreMedia,
} from "./agent-export.ts";

/** Build the content-addressed `<sha256>.<ext>` name for some bytes. */
function nameFor(bytes: Buffer, ext = "png"): string {
  return `${createHash("sha256").update(bytes).digest("hex")}.${ext}`;
}

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
    process.env.ELIZA_STATE_DIR = dir;
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

describe("storedMediaContentMatchesName (restore integrity primitive #9963)", () => {
  it("accepts bytes whose sha256 matches the content-addressed name", () => {
    const bytes = Buffer.from("agent backup media payload");
    expect(storedMediaContentMatchesName(nameFor(bytes), bytes)).toBe(true);
  });

  it("rejects tampered bytes (content no longer hashes to the name)", () => {
    const original = Buffer.from("original media");
    const tampered = Buffer.from("tampered media");
    // Name minted from the ORIGINAL bytes, but the TAMPERED bytes are supplied.
    expect(storedMediaContentMatchesName(nameFor(original), tampered)).toBe(
      false,
    );
  });

  it("rejects non-content-addressed / malformed names", () => {
    const bytes = Buffer.from("x");
    expect(storedMediaContentMatchesName("not-a-hash.png", bytes)).toBe(false);
    expect(storedMediaContentMatchesName("../escape.png", bytes)).toBe(false);
    // 64 hex but no extension → not a valid stored name.
    expect(storedMediaContentMatchesName("a".repeat(64), bytes)).toBe(false);
  });
});

describe("restoreMedia content-integrity gate (#9963)", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "restore-media-test-"));
    process.env.ELIZA_STATE_DIR = dir;
    process.env.ELIZA_STATE_DIR = dir;
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("restores valid media but SKIPS entries whose bytes don't match their name", () => {
    const good = Buffer.from("good restored image");
    const goodName = nameFor(good);
    // A valid-format name (minted from OTHER content) fed TAMPERED bytes — a
    // corrupt/tampered backup. The gate must refuse to write it.
    const tamperedName = nameFor(Buffer.from("the-real-content"));
    const tamperedBytes = Buffer.from(
      "smuggled bytes that do not hash to the name",
    );

    const restored = restoreMedia([
      { fileName: goodName, base64: good.toString("base64") },
      { fileName: tamperedName, base64: tamperedBytes.toString("base64") },
    ]);

    expect(restored).toBe(1); // only the valid entry counts
    expect(readStoredMediaBytes(goodName)?.equals(good)).toBe(true);
    // The tampered entry must NOT have been written under its (mismatched) name.
    expect(readStoredMediaBytes(tamperedName)).toBeNull();
  });

  it("handles an empty/undefined media list", () => {
    expect(restoreMedia(undefined)).toBe(0);
    expect(restoreMedia([])).toBe(0);
  });
});
