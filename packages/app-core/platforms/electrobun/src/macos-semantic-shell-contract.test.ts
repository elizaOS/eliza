/** Pins the native macOS semantic pill lifecycle contract. */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const nativeSource = readFileSync(
  fileURLToPath(new URL("../native/macos/window-effects.mm", import.meta.url)),
  "utf8",
);
const mainSource = readFileSync(
  fileURLToPath(new URL("./index.ts", import.meta.url)),
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

  it("routes the standard application-menu action to the renderer without pointer input", () => {
    expect(mainSource).toContain("action === OPEN_ASSISTANT_ACTION");
    expect(mainSource).toContain('id: "chat-overlay-open"');
    expect(mainSource).toContain(
      'accelerator: "application-menu-accessibility"',
    );
    expect(mainSource).toContain(
      "accepted pointer-free semantic action=open-chat source=application-menu",
    );
    expect(mainSource).not.toMatch(/CGEventPost|CGWarpMouseCursorPosition/);
  });
});
