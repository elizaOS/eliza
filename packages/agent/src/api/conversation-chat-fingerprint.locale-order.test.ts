/**
 * Pins the conversation chat fingerprint to UTF-16 code-unit key ordering.
 * The fingerprint is the idempotency identity for a chat turn, and its input
 * includes caller-supplied `metadata`, so a client controls the property names
 * that reach the canonicalizer. ICU collation orders those names by host locale
 * and ranks canonically equivalent distinct names as equal, which lets two
 * agent replicas derive different fingerprints for the same request and admit a
 * duplicate turn that idempotency was supposed to collapse.
 */
import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { buildConversationChatFingerprint } from "./conversation-routes.ts";

const NFC_KEY = "caf\u00e9"; // precomposed U+00E9
const NFD_KEY = "cafe\u0301"; // decomposed "e" + U+0301

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

const BASE = {
  prompt: "hello",
  images: [],
  source: "api",
  channelType: "dm",
  preferredLanguage: "en",
};

describe("conversation chat fingerprint canonical key order", () => {
  it("orders caller metadata keys by code unit, not by locale collation", () => {
    // ICU collation would emit {"a":1,"B":2}; code-unit order is "B" (0x42)
    // before "a" (0x61). The expected wire string is pinned literally rather
    // than recomputed, so the assertion fails if the sorter regresses.
    expect(
      buildConversationChatFingerprint({ ...BASE, metadata: { a: 1, B: 2 } }),
    ).toBe(
      sha256(
        '{"channelType":"dm","images":[],"metadata":{"B":2,"a":1},"preferredLanguage":"en","prompt":"hello","source":"api"}',
      ),
    );
  });

  it("orders non-ASCII metadata keys by code unit", () => {
    expect(
      buildConversationChatFingerprint({
        ...BASE,
        metadata: { "\u00e4": 1, z: 2 },
      }),
    ).toBe(
      sha256(
        '{"channelType":"dm","images":[],"metadata":{"z":2,"\u00e4":1},"preferredLanguage":"en","prompt":"hello","source":"api"}',
      ),
    );
  });

  it("gives canonically equivalent distinct metadata keys an insertion-independent order", () => {
    // ICU ranks these two distinct property names equal, so the sort falls back
    // to insertion order and the same turn fingerprints two different ways.
    expect(
      buildConversationChatFingerprint({
        ...BASE,
        metadata: { [NFC_KEY]: 1, [NFD_KEY]: 2 },
      }),
    ).toBe(
      buildConversationChatFingerprint({
        ...BASE,
        metadata: { [NFD_KEY]: 2, [NFC_KEY]: 1 },
      }),
    );
  });

  it("still separates turns that genuinely differ", () => {
    expect(
      buildConversationChatFingerprint({ ...BASE, metadata: { a: 1 } }),
    ).not.toBe(
      buildConversationChatFingerprint({ ...BASE, metadata: { a: 2 } }),
    );
  });
});
