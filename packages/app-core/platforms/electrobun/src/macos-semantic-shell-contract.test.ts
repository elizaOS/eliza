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
    const element = implementation("ElizaAssistantSemanticOpenElement");
    const controller = implementation(
      "ElizaWindowInteractiveMaterialController",
    );
    expect(element).toContain("NSAccessibilityButtonRole");
    expect(element).toContain('return @"Open chat"');
    expect(element).toContain('return @"eliza.chat-overlay.open"');
    expect(element).toContain("accessibilityPerformPress");
    expect(element).toContain("[self.controller requestSemanticOpen]");
    expect(controller).toContain("window.accessibilityChildren = @[");
    expect(controller).toContain(
      "self.semanticOriginalAccessibilityChildren ?: @[]",
    );
    expect(element).not.toContain("NSAccessibilityCustomAction");
    expect(controller).not.toContain("NSAccessibilityCustomAction");
    expect(controller).not.toMatch(/CGEventPost|CGWarpMouseCursorPosition/);
    expect(nativeSource).toContain(
      'extern "C" bool pollWindowAssistantSemanticOpenRequest',
    );
  });
});
