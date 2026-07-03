import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";

import type { NormalizedConversation } from "../core/types.ts";
import { claudeParser, detect, parse } from "./claude.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const CLAUDE_EXPORT_DIR = path.join(here, "fixtures", "claude-export");
const CLAUDE_JSON = path.join(CLAUDE_EXPORT_DIR, "conversations.json");

async function collect(
  iterable: AsyncIterable<NormalizedConversation>,
): Promise<NormalizedConversation[]> {
  const out: NormalizedConversation[] = [];
  for await (const c of iterable) out.push(c);
  return out;
}

function findConversation(
  convos: NormalizedConversation[],
  id: string,
): NormalizedConversation {
  const conversation = convos.find((c) => c.sourceConversationId === id);
  expect(conversation).toBeDefined();
  if (!conversation) throw new Error(`Expected Claude conversation ${id}`);
  return conversation;
}

function makeZipWithConversationsJson(json: string): Buffer {
  const fileName = "Claude Export/conversations.json";
  const fileNameBytes = Buffer.from(fileName, "utf8");
  const compressed = deflateRawSync(Buffer.from(json, "utf8"));

  const localHeader = Buffer.alloc(30);
  localHeader.writeUInt32LE(0x04034b50, 0);
  localHeader.writeUInt16LE(20, 4);
  localHeader.writeUInt16LE(0, 6);
  localHeader.writeUInt16LE(8, 8);
  localHeader.writeUInt32LE(0, 10);
  localHeader.writeUInt32LE(0, 14);
  localHeader.writeUInt32LE(compressed.length, 18);
  localHeader.writeUInt32LE(Buffer.byteLength(json), 22);
  localHeader.writeUInt16LE(fileNameBytes.length, 26);
  localHeader.writeUInt16LE(0, 28);

  const centralOffset =
    localHeader.length + fileNameBytes.length + compressed.length;
  const centralHeader = Buffer.alloc(46);
  centralHeader.writeUInt32LE(0x02014b50, 0);
  centralHeader.writeUInt16LE(20, 4);
  centralHeader.writeUInt16LE(20, 6);
  centralHeader.writeUInt16LE(0, 8);
  centralHeader.writeUInt16LE(8, 10);
  centralHeader.writeUInt32LE(0, 12);
  centralHeader.writeUInt32LE(0, 16);
  centralHeader.writeUInt32LE(compressed.length, 20);
  centralHeader.writeUInt32LE(Buffer.byteLength(json), 24);
  centralHeader.writeUInt16LE(fileNameBytes.length, 28);
  centralHeader.writeUInt16LE(0, 30);
  centralHeader.writeUInt16LE(0, 32);
  centralHeader.writeUInt16LE(0, 34);
  centralHeader.writeUInt16LE(0, 36);
  centralHeader.writeUInt32LE(0, 38);
  centralHeader.writeUInt32LE(0, 42);

  const centralSize = centralHeader.length + fileNameBytes.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(centralOffset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([
    localHeader,
    fileNameBytes,
    compressed,
    centralHeader,
    fileNameBytes,
    eocd,
  ]);
}

describe("claude parser: detect()", () => {
  it("returns true for a Claude export directory", async () => {
    expect(await detect(CLAUDE_EXPORT_DIR)).toBe(true);
  });

  it("returns true for conversations.json directly", async () => {
    expect(await detect(CLAUDE_JSON)).toBe(true);
  });

  it("returns false for a non-Claude directory", async () => {
    expect(await detect(path.join(here, "fixtures", "hermes-home"))).toBe(
      false,
    );
  });

  it("returns true for a zipped Claude export containing conversations.json", async () => {
    const tmp = await mkdtemp(path.join(tmpdir(), "claude-export-"));
    const json = await readFile(CLAUDE_JSON, "utf8");
    const zipPath = path.join(tmp, "claude-export.zip");
    await writeFile(zipPath, makeZipWithConversationsJson(json));
    expect(await detect(zipPath)).toBe(true);
  });
});

describe("claude parser: parse() mapping", () => {
  it("maps Claude conversations and chat_messages into normalized conversations", async () => {
    const convos = await collect(parse(CLAUDE_EXPORT_DIR));
    expect(convos).toHaveLength(2);

    const first = findConversation(convos, "claude-conv-1");
    expect(first.title).toBe("Project planning");
    expect(first.createdAt).toBe(Date.parse("2026-01-01T10:00:00.000Z"));
    expect(first.updatedAt).toBe(Date.parse("2026-01-01T10:05:00.000Z"));
    expect(first.meta?.model).toBe("claude-sonnet-4");
    expect(first.meta?.project).toBe("Agent continuity");
    expect(first.meta?.tags).toContain("claude-export");

    expect(first.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(first.messages[0]?.sourceMessageId).toBe("msg-1");
    expect(first.messages[0]?.text).toContain("Summarize the importer plan");
    expect(first.messages[1]?.text).toContain("Use DocumentService");
  });

  it("flattens typed content blocks and code blocks", async () => {
    const convos = await collect(parse(CLAUDE_EXPORT_DIR));
    const second = findConversation(convos, "claude-conv-2");

    expect(second.messages[0]?.text).toContain("Here is a snippet");
    expect(second.messages[0]?.text).toContain("```ts");
    expect(second.messages[0]?.text).toContain("const ok = true;");
  });

  it("keeps extracted attachment text as normalized attachments", async () => {
    const convos = await collect(parse(CLAUDE_EXPORT_DIR));
    const first = findConversation(convos, "claude-conv-1");

    const attachment = first.messages[0]?.attachments?.[0];
    expect(attachment).toEqual({
      name: "scope.md",
      kind: "extracted-text",
      text: "Track C should parse Claude chat_messages and inline attachments.",
    });
  });

  it("can omit attachments when includeAttachments=false", async () => {
    const convos = await collect(
      parse(CLAUDE_EXPORT_DIR, { includeAttachments: false }),
    );
    const first = findConversation(convos, "claude-conv-1");
    expect(first.messages[0]?.attachments).toBeUndefined();
  });

  it("streams incrementally from conversations.json", async () => {
    const iterator = parse(CLAUDE_JSON)[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.done).toBe(false);
    expect(first.value.sourceConversationId).toBe("claude-conv-1");
    await iterator.return?.();
  });

  it("parses a zipped Claude export", async () => {
    const tmp = await mkdtemp(path.join(tmpdir(), "claude-export-"));
    await mkdir(path.join(tmp, "nested"));
    const json = await readFile(CLAUDE_JSON, "utf8");
    const zipPath = path.join(tmp, "nested", "claude-export.zip");
    await writeFile(zipPath, makeZipWithConversationsJson(json));

    const convos = await collect(parse(zipPath));
    expect(convos.map((c) => c.sourceConversationId)).toEqual([
      "claude-conv-1",
      "claude-conv-2",
    ]);
  });
});

describe("claude parser: exported parser object", () => {
  it("exposes a ConversationParser with source 'claude'", () => {
    expect(claudeParser.source).toBe("claude");
    expect(typeof claudeParser.detect).toBe("function");
    expect(typeof claudeParser.parse).toBe("function");
  });
});
