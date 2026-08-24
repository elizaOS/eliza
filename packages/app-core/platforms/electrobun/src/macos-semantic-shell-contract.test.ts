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
    const controller = implementation(
      "ElizaWindowInteractiveMaterialController",
    );
    expect(controller).toContain("NSAccessibilityCustomAction");
    expect(controller).toContain('initWithName:@"Open chat"');
    expect(controller).toContain("[weakSelf requestSemanticOpen]");
    expect(controller).toContain("window.accessibilityCustomActions = actions");
    expect(controller).toContain("contentView.accessibilityHidden = YES");
    expect(controller).toContain(
      "contentView.accessibilityHidden =\n\t\t\t\tself.semanticContentAccessibilityWasHidden",
    );
    expect(controller).not.toMatch(/CGEventPost|CGWarpMouseCursorPosition/);
    expect(nativeSource).toContain(
      'extern "C" bool pollWindowAssistantSemanticOpenRequest',
    );
  });
});
