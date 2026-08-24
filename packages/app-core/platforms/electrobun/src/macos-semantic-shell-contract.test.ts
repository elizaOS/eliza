/** Pins the native macOS semantic pill lifecycle contract. */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const nativeSource = readFileSync(
  fileURLToPath(new URL("../native/macos/window-effects.mm", import.meta.url)),
  "utf8",
);

function implementation(name: string): string {
  const start = nativeSource.indexOf(`@implementation ${name}`);
  if (start < 0) throw new Error(`missing native implementation ${name}`);
  const end = nativeSource.indexOf("@end", start);
  if (end < 0) throw new Error(`unterminated native implementation ${name}`);
  return nativeSource.slice(start, end + "@end".length);
}

describe("macOS semantic shell contract", () => {
  it("opens the resting pill through one AX-only control without HID input", () => {
    const semanticView = implementation("ElizaAssistantSemanticOpenView");
    expect(semanticView).toContain('return @"eliza.chat-overlay.open"');
    expect(semanticView).toContain("return NSAccessibilityButtonRole");
    expect(semanticView).toContain("accessibilityPerformPress");
    expect(semanticView).toContain("return nil;");
    expect(semanticView).not.toMatch(/CGEventPost|CGWarpMouseCursorPosition/);
    expect(nativeSource).toContain(
      'extern "C" bool pollWindowAssistantSemanticOpenRequest',
    );
  });
});
