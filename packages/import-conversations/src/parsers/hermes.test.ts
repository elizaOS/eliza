/** Unit tests for the Hermes home parser: detect() and session/memory normalization over tmp-dir fixtures. Deterministic. */

import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import type { NormalizedConversation } from "../core/types.ts";
import { detect, hermesParser, parse } from "./hermes.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const HERMES_HOME = path.join(here, "fixtures", "hermes-home");
const SESSIONS_DIR = path.join(HERMES_HOME, "sessions");

/** Drain an async iterable into an array (test helper). */
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
  if (!conversation) {
    throw new Error(`Expected Hermes conversation ${id}`);
  }
  return conversation;
}

describe("hermes parser: detect()", () => {
  it("returns true for a Hermes home dir (has sessions/ with .jsonl)", async () => {
    expect(await detect(HERMES_HOME)).toBe(true);
  });

  it("returns true when pointed directly at a sessions/ dir", async () => {
    expect(await detect(SESSIONS_DIR)).toBe(true);
  });

  it("returns false for a non-existent path", async () => {
    expect(await detect(path.join(here, "does-not-exist"))).toBe(false);
  });

  it("returns false for a dir without a sessions/ subdir", async () => {
    // The memories dir has no sessions/ under it.
    expect(await detect(path.join(HERMES_HOME, "memories"))).toBe(false);
  });

  it("throws when sessions/ exists but is unreadable (real I/O error, not 'not a Hermes home')", async () => {
    // sessions/ exists (existsSync passes) but is a regular file, so readdir
    // fails with ENOTDIR. That is a real I/O error on required input and must
    // surface, not be swallowed as a plain false.
    const home = await mkdtemp(path.join(tmpdir(), "hermes-badsessions-"));
    await writeFile(path.join(home, "sessions"), "not a directory", "utf8");
    await expect(detect(home)).rejects.toThrow();
  });
});

describe("hermes parser: parse() fail-closed on I/O", () => {
  it("surfaces a readdir failure on an existing sessions/ instead of importing zero sessions", async () => {
    // sessions/ resolves (existsSync passes) but is a file: readdir throws.
    // parse() must propagate that rather than silently yielding nothing.
    const home = await mkdtemp(path.join(tmpdir(), "hermes-parse-io-"));
    await writeFile(path.join(home, "sessions"), "not a directory", "utf8");
    await expect(
      collect(parse(home, { includeMemories: false })),
    ).rejects.toThrow();
  });

  it("surfaces a readdir failure on an existing memories/ instead of dropping notes", async () => {
    // A valid sessions/ dir (so parse gets past sessions), plus a memories/
    // that exists as a file: the memories readdir must surface, not be dropped.
    const home = await mkdtemp(path.join(tmpdir(), "hermes-mem-io-"));
    await mkdir(path.join(home, "sessions"));
    await writeFile(path.join(home, "memories"), "not a directory", "utf8");
    await expect(
      collect(parse(home, { includeMemories: true })),
    ).rejects.toThrow();
  });
});

describe("hermes parser: parse() mapping", () => {
  it("parses session_meta into conversation meta and drops it as a message", async () => {
    const convos = await collect(
      parse(HERMES_HOME, { includeMemories: false }),
    );
    const first = findConversation(convos, "20260101_120000_aaaa1111");
    // Title derived from the timestamped filename.
    expect(first.title).toBe("Hermes session 2026-01-01 12:00:00");
    // model from meta.
    expect(first.meta?.model).toBe("test-model-x");
    // platform surfaced as a tag.
    expect(first.meta?.tags).toContain("platform:discord");
    // createdAt anchored to the meta timestamp (epoch ms).
    expect(first.createdAt).toBe(Date.parse("2026-01-01T12:00:00.000000"));
    // The session_meta line is NOT a message.
    expect(first.messages.every((m) => m.role !== "system")).toBe(true);
  });

  it("drops the reasoning (chain-of-thought) field by default", async () => {
    const convos = await collect(
      parse(HERMES_HOME, { includeMemories: false }),
    );
    const first = findConversation(convos, "20260101_120000_aaaa1111");
    for (const m of first.messages) {
      expect(m.text).not.toContain("respond briefly per SOUL.md");
      expect(m.text).not.toContain("need to call a tool");
      expect(m.text).not.toContain("reasoning");
    }
  });

  it("optionally includes reasoning as a fenced block when includeReasoning=true", async () => {
    const convos = await collect(
      parse(HERMES_HOME, { includeMemories: false, includeReasoning: true }),
    );
    const first = findConversation(convos, "20260101_120000_aaaa1111");
    const withReasoning = first.messages.find((m) =>
      m.text.includes("respond briefly per SOUL.md"),
    );
    expect(withReasoning).toBeDefined();
    expect(withReasoning?.text).toContain("```reasoning");
  });

  it("maps roles: user + assistant present, tool dropped by default", async () => {
    const convos = await collect(
      parse(HERMES_HOME, { includeMemories: false }),
    );
    const first = findConversation(convos, "20260101_120000_aaaa1111");
    const roles = first.messages.map((m) => m.role);
    expect(roles).toContain("user");
    expect(roles).toContain("assistant");
    expect(roles).not.toContain("tool");
  });

  it("sets annotations.toolName on assistant tool_calls", async () => {
    const convos = await collect(
      parse(HERMES_HOME, { includeMemories: false }),
    );
    const first = findConversation(convos, "20260101_120000_aaaa1111");
    const toolCaller = first.messages.find(
      (m) => m.annotations?.toolName === "skill_view",
    );
    expect(toolCaller).toBeDefined();
    expect(toolCaller?.role).toBe("assistant");
  });

  it("includes tool messages (with toolName from tool_call_id) when includeToolMessages=true", async () => {
    const convos = await collect(
      parse(HERMES_HOME, { includeMemories: false, includeToolMessages: true }),
    );
    const first = findConversation(convos, "20260101_120000_aaaa1111");
    const toolMsg = first.messages.find((m) => m.role === "tool");
    expect(toolMsg).toBeDefined();
    expect(toolMsg?.annotations?.toolName).toBe("call_1");
  });

  it("skips a malformed JSON line without crashing (resilience)", async () => {
    const convos = await collect(
      parse(HERMES_HOME, { includeMemories: false }),
    );
    const first = findConversation(convos, "20260101_120000_aaaa1111");
    // The two user lines ("hey there", "thanks") both survive; the malformed
    // line between them is skipped rather than aborting the file.
    const userTexts = first.messages
      .filter((m) => m.role === "user")
      .map((m) => m.text);
    expect(userTexts).toEqual(["hey there", "thanks"]);
  });

  it("handles a session with NO session_meta header (older format)", async () => {
    const convos = await collect(
      parse(HERMES_HOME, { includeMemories: false }),
    );
    const noMeta = findConversation(convos, "20260103_090000_cccc3333");
    // First line was a real user message and must be retained.
    expect(noMeta.messages[0]?.role).toBe("user");
    expect(noMeta.messages[0]?.text).toBe("no meta header session");
    // No meta timestamp -> createdAt falls back to the earliest message time.
    expect(noMeta.createdAt).toBe(Date.parse("2026-01-03T09:00:00.000000"));
  });

  it("sets per-message createdAt from ISO timestamps (epoch ms)", async () => {
    const convos = await collect(
      parse(HERMES_HOME, { includeMemories: false }),
    );
    const first = findConversation(convos, "20260101_120000_aaaa1111");
    const user = first.messages.find((m) => m.role === "user");
    expect(user?.createdAt).toBe(Date.parse("2026-01-01T12:00:05.000000"));
  });

  it("derives createdAt/updatedAt bounds from the min/max message time", async () => {
    // When there IS a meta header, createdAt anchors to it; updatedAt tracks the
    // latest message. Verifies the incremental min/max bookkeeping (no array
    // spread) produces correct bounds.
    const convos = await collect(
      parse(HERMES_HOME, { includeMemories: false }),
    );
    const first = findConversation(convos, "20260101_120000_aaaa1111");
    expect(first.createdAt).toBe(Date.parse("2026-01-01T12:00:00.000000"));
    // Latest surviving message timestamp in the fixture is the final "thanks".
    expect(first.updatedAt).toBe(Date.parse("2026-01-01T12:00:10.000000"));
  });
});

describe("hermes parser: multi-session dir + streaming", () => {
  it("yields one conversation per session, in chronological (filename) order", async () => {
    const convos = await collect(
      parse(HERMES_HOME, { includeMemories: false }),
    );
    const ids = convos.map((c) => c.sourceConversationId);
    expect(ids).toEqual([
      "20260101_120000_aaaa1111",
      "20260102_083000_bbbb2222",
      "20260103_090000_cccc3333",
    ]);
  });

  it("streams incrementally (generator yields before all sessions are read)", async () => {
    const iterator = parse(HERMES_HOME, { includeMemories: false })[
      Symbol.asyncIterator
    ]();
    const firstResult = await iterator.next();
    expect(firstResult.done).toBe(false);
    // We got the first conversation without having drained the whole dir; this
    // proves the async generator is lazy/streaming, not batch-then-return.
    expect(firstResult.value.sourceConversationId).toBe(
      "20260101_120000_aaaa1111",
    );
    const secondResult = await iterator.next();
    expect(secondResult.value?.sourceConversationId).toBe(
      "20260102_083000_bbbb2222",
    );
  });
});

describe("hermes parser: memory notes lane", () => {
  it("includes memories/*.md as date-titled single-note conversations by default", async () => {
    const convos = await collect(parse(HERMES_HOME));
    const note = convos.find(
      (c) => c.sourceConversationId === "memory:2026-01-01",
    );
    expect(note).toBeDefined();
    expect(note?.title).toBe("Hermes daily note 2026-01-01");
    expect(note?.messages).toHaveLength(1);
    expect(note?.messages[0]?.role).toBe("system");
    expect(note?.messages[0]?.text).toContain("Synthetic daily note");
    expect(note?.meta?.tags).toContain("memory-note");
    expect(note?.meta?.tags).toContain("date:2026-01");
  });

  it("omits memory notes when includeMemories=false", async () => {
    const convos = await collect(
      parse(HERMES_HOME, { includeMemories: false }),
    );
    expect(
      convos.some((c) => c.sourceConversationId.startsWith("memory:")),
    ).toBe(false);
  });
});

describe("hermes parser: exported parser object", () => {
  it("exposes a ConversationParser with source 'hermes'", () => {
    expect(hermesParser.source).toBe("hermes");
    expect(typeof hermesParser.detect).toBe("function");
    expect(typeof hermesParser.parse).toBe("function");
  });
});
