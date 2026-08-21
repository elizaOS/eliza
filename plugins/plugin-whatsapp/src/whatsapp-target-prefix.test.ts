/**
 * Isolated hang tests for linear `whatsapp:` prefix stripping.
 * Deterministic — no connector, Baileys, or phone parser.
 */
import { describe, expect, it } from "vitest";
import { stripWhatsAppTargetPrefixes } from "./whatsapp-target-prefix.ts";

describe("stripWhatsAppTargetPrefixes", () => {
  it("strips zero or one honest prefix", () => {
    expect(stripWhatsAppTargetPrefixes("41796666864")).toBe("41796666864");
    expect(stripWhatsAppTargetPrefixes("whatsapp:+41796666864")).toBe("+41796666864");
    expect(stripWhatsAppTargetPrefixes("WHATSAPP: 41796666864")).toBe("41796666864");
  });

  it("strips stacked prefixes without quadratic copies", () => {
    const n = 100_000;
    const input = `${"whatsapp:".repeat(n)}+4179`;
    const t0 = performance.now();
    expect(stripWhatsAppTargetPrefixes(input)).toBe("+4179");
    expect(performance.now() - t0).toBeLessThan(50);
  });

  it("preserves String.trim compatibility around every prefix", () => {
    const whitespace = [
      "\u0009",
      "\u000a",
      "\u000b",
      "\u000c",
      "\u000d",
      "\u0020",
      "\u00a0",
      "\u1680",
      "\u2000",
      "\u2001",
      "\u2002",
      "\u2003",
      "\u2004",
      "\u2005",
      "\u2006",
      "\u2007",
      "\u2008",
      "\u2009",
      "\u200a",
      "\u2028",
      "\u2029",
      "\u202f",
      "\u205f",
      "\u3000",
      "\ufeff",
    ];

    for (const space of whitespace) {
      expect(
        stripWhatsAppTargetPrefixes(`${space}whatsapp:${space}WHATSAPP:${space}+4179${space}`)
      ).toBe("+4179");
    }
  });
});
