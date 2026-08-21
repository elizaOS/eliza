/** Surrogate safety for XDmAdapter in lifeops-message-adapter.ts — exercises system under test. */

import type { Memory } from "@elizaos/core";
import { describe, expect, test } from "vitest";
import {
  formatDmSnippet,
  formatDraftPreview,
  memoryToMessageRef,
  XDmAdapter,
} from "./lifeops-message-adapter.ts";

function isWellFormed(value: string): boolean {
  if (!value) return true;
  const maybe = value as unknown as { isWellFormed?: () => boolean };
  if (typeof maybe.isWellFormed === "function") return maybe.isWellFormed();
  return true;
}

function makeMemory(text: string): Memory {
  return {
    id: "mem-1",
    entityId: "entity-1",
    roomId: "room-1",
    agentId: "agent-1",
    content: { text },
    metadata: { x: { senderId: "sender-1", conversationId: "conv-1" } },
    createdAt: Date.now(),
  } as unknown as Memory;
}

// Helpers are production-owned (imported from adapter), not copied in test.
describe("XDmAdapter surrogate safety", () => {
  test("helpers truncate at astral boundary without lone surrogate", () => {
    const fox = "🦊";
    const body = `${"a".repeat(199)}${fox}${"b".repeat(50)}`;
    const snippet = formatDmSnippet(body);
    expect(isWellFormed(snippet)).toBe(true);
    expect(snippet).toBe("a".repeat(199));
    expect(() => JSON.stringify({ snippet })).not.toThrow();
    const previewBody = `${"a".repeat(196)}${fox}${"b".repeat(50)}`;
    const preview = formatDraftPreview(previewBody);
    expect(isWellFormed(preview)).toBe(true);
    expect(preview.endsWith("...")).toBe(true);
    expect(() => JSON.stringify({ preview })).not.toThrow();
  });

  test("memoryToMessageRef snippet path is well-formed at 200 cap", () => {
    const fox = "🦊";
    const body = `${"a".repeat(199)}${fox}${"b".repeat(50)}`;
    const ref = memoryToMessageRef(makeMemory(body));
    expect(isWellFormed(ref.snippet)).toBe(true);
    expect(ref.snippet).toBe("a".repeat(199));
    expect(ref.snippet.length).toBeLessThanOrEqual(200);
    expect(() => JSON.stringify(ref)).not.toThrow();
    // lone high surrogate sanitized via production path
    const bad = makeMemory(`Bad \ud800 dm body ${"x".repeat(300)}`);
    const badRef = memoryToMessageRef(bad);
    expect(isWellFormed(badRef.snippet)).toBe(true);
    expect(badRef.snippet.includes("\ud800")).toBe(false);
  });

  test("XDmAdapter.createDraft preview path is well-formed (exercises adapter)", async () => {
    const adapter = new XDmAdapter();
    const fox = "🦊";
    // access protected createDraftImpl via bracket notation for test
    const createDraft = (
      adapter as unknown as {
        createDraftImpl: (
          r: unknown,
          d: unknown,
        ) => Promise<{ preview: string }>;
      }
    ).createDraftImpl.bind(adapter);
    const body = `${"a".repeat(196)}${fox}${"b".repeat(50)}`;
    const { preview } = await createDraft(
      {} as never,
      { to: [{ identifier: "123" }], body } as never,
    );
    expect(isWellFormed(preview)).toBe(true);
    expect(preview.endsWith("...")).toBe(true);
    expect(() => JSON.stringify({ preview })).not.toThrow();
    // malformed surrogate via real adapter preview
    const badBody = `Bad \ud800 body ${"x".repeat(300)}`;
    const { preview: badPreview } = await createDraft(
      {} as never,
      { to: [{ identifier: "123" }], body: badBody } as never,
    );
    expect(isWellFormed(badPreview)).toBe(true);
    expect(badPreview.includes("\ud800")).toBe(false);
  });

  test("sweep offsets around 200 cap all stay well-formed via production helpers", () => {
    const fox = "🦊";
    for (let offset = -5; offset <= 5; offset++) {
      const n = 200 + offset;
      const body = `${"a".repeat(n)}${fox}${"b".repeat(20)}`;
      const snippet = formatDmSnippet(body);
      const preview = formatDraftPreview(body);
      expect(isWellFormed(snippet)).toBe(true);
      expect(isWellFormed(preview)).toBe(true);
      // also via memoryToMessageRef for snippet
      const ref = memoryToMessageRef(makeMemory(body));
      expect(isWellFormed(ref.snippet)).toBe(true);
    }
  });
});
