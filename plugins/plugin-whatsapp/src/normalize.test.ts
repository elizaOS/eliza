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
  normalizeBaileysSendTarget,
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

  it("rejects embedded or repeated plus signs", () => {
    for (const value of ["12+3456789012", "+1+4155550123", "++14155550123"]) {
      expect(normalizeE164(value)).toBe("");
      expect(normalizeWhatsAppTarget(value)).toBeNull();
    }
  });

  it("rejects alphabetic junk, invalid country codes, and overlong numbers", () => {
    for (const value of [
      "+1abc4155550123",
      "+012345678901",
      "+1234567890123456",
      "001234567890123456",
      "1234567890123456",
    ]) {
      expect(normalizeE164(value)).toBe("");
      expect(normalizeWhatsAppTarget(value)).toBeNull();
    }
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

describe("outbound transport target normalization", () => {
  it("preserves recognized LIDs and groups for Baileys", () => {
    expect(normalizeBaileysSendTarget("1234567890@lid")).toBe("1234567890@lid");
    expect(normalizeBaileysSendTarget("123456789-987654321@g.us")).toBe("123456789-987654321@g.us");
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

  it("chunkWhatsAppText keeps a surrogate pair (emoji) intact at the hard-break fallback", () => {
    // No whitespace/newlines/sentence breaks in range, so splitAtBreakPoint
    // falls through to the hard break at `limit`. A naive slice(0, 4096)
    // would cut between the emoji's high and low surrogate.
    const text = `${"x".repeat(4095)}\u{1F600}${"y".repeat(10)}`;

    const chunks = chunkWhatsAppText(text);

    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(4096);
      expect(chunk.isWellFormed()).toBe(true);
    }
    expect(chunks.join("")).toBe(text);
  });

  it("truncateText keeps a surrogate pair (emoji) intact instead of splitting it", () => {
    // maxLength - 3 (ellipsis reserve) lands right after the emoji's high
    // surrogate; a naive slice(0, maxLength - 3) would strand it.
    const text = `xxxx\u{1F600}zzzzz`;

    const truncated = truncateText(text, 8);

    expect(truncated.length).toBeLessThanOrEqual(8);
    expect(truncated.isWellFormed()).toBe(true);
    expect(truncated).toBe("xxxx...");
  });

  it("chunkWhatsAppText fails closed on a one-code-unit limit instead of looping forever", () => {
    // A single code unit can never hold half of an astral character, so no
    // limit of 1 can guarantee a non-empty well-formed chunk on every input.
    expect(() => chunkWhatsAppText(`${"x".repeat(10)}\u{1F600}`, { limit: 1 })).toThrow(
      /limit must be a finite number/
    );
  });

  it.each([0, -5, Number.NaN, Number.POSITIVE_INFINITY])(
    "chunkWhatsAppText fails closed on limit %p",
    (limit) => {
      expect(() => chunkWhatsAppText("hello world", { limit })).toThrow(
        /limit must be a finite number/
      );
    }
  );

  it("chunkWhatsAppText makes progress and stays well-formed at the minimum supported limit", () => {
    // limit: 2 is the smallest bound that can ever hold one astral character
    // whole. Every produced chunk must be non-empty, within the limit,
    // well-formed, and the chunks must rejoin losslessly.
    const text = `\u{1F600}\u{1F601}\u{1F602}`;

    const chunks = chunkWhatsAppText(text, { limit: 2 });

    expect(chunks.length).toBeGreaterThan(0);
    for (const chunk of chunks) {
      expect(chunk.length).toBeGreaterThan(0);
      expect(chunk.length).toBeLessThanOrEqual(2);
      expect(chunk.isWellFormed()).toBe(true);
    }
    expect(chunks.join("")).toBe(text);
  });
});
