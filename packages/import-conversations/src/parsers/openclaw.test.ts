/** Unit tests for the OpenClaw home parser and its shared importer integration. */

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { FakeDocumentSink } from "../__tests__/helpers.ts";
import { collectImport } from "../core/pipeline.ts";
import { REDACTED_PLACEHOLDER } from "../core/redact.ts";
import type { NormalizedConversation } from "../core/types.ts";
import { detect, openclawParser, parse } from "./openclaw.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const OPENCLAW_HOME = path.join(here, "fixtures", "openclaw-home");
const OPENCLAW_NESTED = path.join(here, "fixtures", "openclaw-nested");

async function collect(
  iterable: AsyncIterable<NormalizedConversation>,
): Promise<NormalizedConversation[]> {
  const out: NormalizedConversation[] = [];
  for await (const conversation of iterable) out.push(conversation);
  return out;
}

function findConversation(
  conversations: NormalizedConversation[],
  id: string,
): NormalizedConversation {
  const conversation = conversations.find((c) => c.sourceConversationId === id);
  expect(conversation).toBeDefined();
  if (!conversation) throw new Error(`Expected OpenClaw conversation ${id}`);
  return conversation;
}

describe("openclaw parser: detect()", () => {
  it("returns true for an OpenClaw markdown home", async () => {
    expect(await detect(OPENCLAW_HOME)).toBe(true);
    expect(await openclawParser.detect(OPENCLAW_HOME)).toBe(true);
  });

  it("returns true for a nested workspace OpenClaw home", async () => {
    expect(await detect(OPENCLAW_NESTED)).toBe(true);
  });

  it("returns false for a non-existent path", async () => {
    expect(await detect(path.join(here, "does-not-exist"))).toBe(false);
  });

  it("does not treat generic AGENTS.md repos as OpenClaw homes", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "openclaw-agents-only-"));
    await writeFile(path.join(dir, "AGENTS.md"), "# Agent instructions\n");
    await writeFile(path.join(dir, "MEMORY.md"), "# Generic project memory\n");

    expect(await detect(dir)).toBe(false);
  });

  it("does not detect persona markers without importable memory", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "openclaw-marker-only-"));
    await writeFile(path.join(dir, "SOUL.md"), "# Persona only\n");

    expect(await detect(dir)).toBe(false);
  });
});

describe("openclaw parser: parse() mapping", () => {
  it("maps root, awareness, daily, and named memory into normalized conversations", async () => {
    const conversations = await collect(parse(OPENCLAW_HOME));
    expect(conversations.map((c) => c.sourceConversationId)).toEqual([
      "root:memory",
      "memory:aurora-awareness",
      "memory:2026-02-03",
      "memory:aurora-thoughts",
      "memory:conversation-playbook",
    ]);

    const root = findConversation(conversations, "root:memory");
    expect(root.title).toBe("OpenClaw root memory (MEMORY.md)");
    expect(root.messages[0]?.role).toBe("system");
    expect(root.messages[0]?.text).toContain("Long-term project memory");
    expect(root.meta?.tags).toContain("root-memory");

    const daily = findConversation(conversations, "memory:2026-02-03");
    expect(daily.title).toBe("OpenClaw daily note 2026-02-03");
    expect(daily.createdAt).toBe(Date.parse("2026-02-03T00:00:00Z"));
    expect(daily.meta?.tags).toContain("daily-memory");
    expect(daily.meta?.tags).toContain("date:2026-02");

    const named = findConversation(
      conversations,
      "memory:conversation-playbook",
    );
    expect(named.title).toBe("OpenClaw memory Conversation Playbook");
    expect(named.meta?.tags).toContain("named-memory");
  });

  it("does not import USER.md, TOOLS.md, or secrets by default", async () => {
    const conversations = await collect(parse(OPENCLAW_HOME));
    const importedText = conversations
      .flatMap((conversation) => conversation.messages.map((m) => m.text))
      .join("\n");
    expect(importedText).not.toContain("OWNER_PRIVATE_CONTEXT");
    expect(importedText).not.toContain("TOOLS_PRIVATE_MARKER");
    expect(importedText).not.toContain("SECRET_DIR_MARKER");
  });

  it("can explicitly include persona files without importing USER.md or TOOLS.md", async () => {
    const conversations = await collect(
      parse(OPENCLAW_HOME, { includePersonaFiles: true }),
    );
    expect(conversations.map((c) => c.sourceConversationId)).toContain(
      "persona:soul",
    );
    expect(conversations.map((c) => c.sourceConversationId)).toContain(
      "persona:agents",
    );
    const importedText = conversations
      .flatMap((conversation) => conversation.messages.map((m) => m.text))
      .join("\n");
    expect(importedText).toContain("Aurora synthetic OpenClaw agent");
    expect(importedText).not.toContain("OWNER_PRIVATE_CONTEXT");
    expect(importedText).not.toContain("TOOLS_PRIVATE_MARKER");
  });

  it("runs through the shared pipeline with OpenClaw provenance and redaction", async () => {
    const sink = new FakeDocumentSink();
    const result = await collectImport(parse(OPENCLAW_HOME), {
      source: "openclaw",
      batchId: "openclaw-batch",
      sink,
      now: () => 1_700_000_000_000,
    });

    expect(result.report.summary.added).toBe(5);
    const stored = [...sink.stored.values()];
    expect(stored).toHaveLength(5);
    const rendered = stored.map((doc) => doc.content).join("\n");
    expect(rendered).toContain("imported from OpenClaw");
    expect(rendered).toContain(REDACTED_PLACEHOLDER);
    expect(rendered).not.toContain("sk-openclawFixtureKey123456");
    expect(
      stored.every(
        (doc) =>
          (doc.metadata as { import?: { source?: string } }).import?.source ===
          "openclaw",
      ),
    ).toBe(true);
  });
});
