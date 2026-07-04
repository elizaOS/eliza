/**
 * Unit coverage for the phone/JID normalization helpers: E.164 parsing, JID and
 * LID recognition, chat-type detection, target normalization, and text chunking.
 * Pure functions — no runtime or network.
 */
import { describe, expect, it } from "vitest";
import {
  buildWhatsAppUserJid,
  chunkWhatsAppText,
  getWhatsAppChatType,
  isWhatsAppGroupJid,
  isWhatsAppUserTarget,
  normalizeE164,
  normalizeWhatsAppTarget,
  truncateText,
} from "./normalize.ts";

/**
 * WhatsApp phone/JID normalization keys an inbound sender to a stable identity
 * and resolves outbound targets. E.164 is the canonical phone form; group JIDs
 * (@g.us) and user JIDs (@s.whatsapp.net / @lid) must be classified correctly,
 * and an unrecognized JID-ish string must fail closed (null) rather than be
 * mistaken for a phone number and messaged to the wrong place.
 */

describe("normalizeE164", () => {
  it("canonicalizes separators, 00 prefix, and bare full numbers", () => {
    expect(normalizeE164("+1 (415) 555-0123")).toBe("+14155550123");
    expect(normalizeE164("0041796666864")).toBe("+41796666864");
    expect(normalizeE164("14155550123")).toBe("+14155550123");
    expect(normalizeE164("123")).toBe("123"); // too short, returned as-is
    expect(normalizeE164("abc")).toBe("");
  });
});

describe("JID classification", () => {
  it("recognizes group vs user JIDs", () => {
    expect(isWhatsAppGroupJid("123456789-987654321@g.us")).toBe(true);
    expect(isWhatsAppGroupJid("41796666864@s.whatsapp.net")).toBe(false);
    expect(isWhatsAppUserTarget("41796666864:0@s.whatsapp.net")).toBe(true);
    expect(isWhatsAppUserTarget("123456@lid")).toBe(true);
    expect(getWhatsAppChatType("123-456@g.us")).toBe("group");
    expect(getWhatsAppChatType("41796666864@s.whatsapp.net")).toBe("user");
  });
});

describe("normalizeWhatsAppTarget", () => {
  it("normalizes phones, user JIDs, and group JIDs", () => {
    expect(normalizeWhatsAppTarget("+41 79 666 6864")).toBe("+41796666864");
    expect(normalizeWhatsAppTarget("41796666864:0@s.whatsapp.net")).toBe("+41796666864");
    expect(normalizeWhatsAppTarget("123456789-987654321@g.us")).toBe("123456789-987654321@g.us");
  });

  it("fails closed on empty or unrecognized JID-ish input", () => {
    expect(normalizeWhatsAppTarget("")).toBeNull();
    expect(normalizeWhatsAppTarget("group:120@g.us")).toBeNull();
    expect(normalizeWhatsAppTarget("weird@unknown.domain")).toBeNull();
  });
});

describe("buildWhatsAppUserJid", () => {
  it("builds a bare-digit @s.whatsapp.net jid", () => {
    expect(buildWhatsAppUserJid("+41796666864")).toBe("41796666864@s.whatsapp.net");
  });
});

describe("text chunking", () => {
  it("chunkWhatsAppText keeps every chunk within the limit and preserves content", () => {
    const text = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n");
    const chunks = chunkWhatsAppText(text, { limit: 40 });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.length <= 40)).toBe(true);
    expect(chunks.join("\n").replace(/\s+/g, "")).toBe(text.replace(/\s+/g, ""));
  });

  it("truncateText appends an ellipsis when over the limit", () => {
    expect(truncateText("short", 20)).toBe("short");
    expect(truncateText("abcdefghij", 5).length).toBeLessThanOrEqual(5);
  });
});
