import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  resolve(
    dirname(fileURLToPath(import.meta.url)),
    "BrowserBridgeSetupPanel.tsx",
  ),
  "utf8",
);

describe("BrowserBridgeSetupPanel visual copy", () => {
  it("keeps browser setup compact and free of raw bullet glyphs", () => {
    expect(source).not.toContain("Guided Browser Setup");
    expect(source).not.toContain("Use this when you want the easy path");
    expect(source).not.toContain("No browser profiles have connected yet");
    expect(source).not.toContain(" • ");
  });
});
