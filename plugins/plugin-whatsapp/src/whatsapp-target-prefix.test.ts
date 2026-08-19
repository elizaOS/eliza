/**
 * Isolated hang tests for linear `whatsapp:` prefix stripping.
 * Deterministic — no connector, Baileys, or phone parser.
 */
import { describe, expect, it } from "vitest";
import { stripWhatsAppTargetPrefixes } from "./whatsapp-target-prefix.ts";

describe("stripWhatsAppTargetPrefixes", () => {
  it("strips zero or one honest prefix", () => {
    expect(stripWhatsAppTargetPrefixes("41796666864")).toBe("41796666864");
    expect(stripWhatsAppTargetPrefixes("whatsapp:+41796666864")).toBe(
      "+41796666864",
    );
    expect(stripWhatsAppTargetPrefixes("WHATSAPP: 41796666864")).toBe(
      "41796666864",
    );
  });

  it("strips stacked prefixes without quadratic copies", () => {
    const n = 100_000;
    const input = `${"whatsapp:".repeat(n)}+4179`;
    const t0 = performance.now();
    expect(stripWhatsAppTargetPrefixes(input)).toBe("+4179");
    expect(performance.now() - t0).toBeLessThan(50);
  });
});
