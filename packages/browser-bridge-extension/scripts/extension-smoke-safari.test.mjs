/**
 * Deterministic coverage for Safari's human-readable extension-plist parser.
 */
import { describe, expect, it } from "vitest";
import { parseSafariWebExtensionsPlist } from "./extension-smoke-safari.mjs";

describe("parseSafariWebExtensionsPlist", () => {
  it("distinguishes active and removed extension records", () => {
    const records = parseSafariWebExtensionsPlist(`{
  "com.apple.Safari.UnpackedExtensions.ACTIVE (UNSIGNED)" => {
    "Enabled" => true
  }
  "com.apple.Safari.UnpackedExtensions.REMOVED (UNSIGNED)" => {
    "Enabled" => false
    "RemovedDate" => 2026-08-18 19:55:59 +0000
  }
}`);

    expect([...records]).toEqual([
      [
        "com.apple.Safari.UnpackedExtensions.ACTIVE (UNSIGNED)",
        { removed: false },
      ],
      [
        "com.apple.Safari.UnpackedExtensions.REMOVED (UNSIGNED)",
        { removed: true },
      ],
    ]);
  });
});
