/** Verifies deterministic Gradle paths for standard and Bun-store installs. */
import { describe, expect, it } from "vitest";
import { normalizeCapacitorSettings } from "./portable-capacitor-settings.mjs";

describe("normalizeCapacitorSettings", () => {
  it("replaces Bun-store paths with runtime package resolution", () => {
    const generated = `project(':capacitor-app').projectDir = new File('../../node_modules/.bun/@capacitor+app@8.0.0+hash/node_modules/@capacitor/app/android')\n`;
    const normalized = normalizeCapacitorSettings(generated);

    expect(normalized).toContain("String resolveNodePackageDir");
    expect(normalized).toContain(
      "new File(resolveNodePackageDir('@capacitor/app'), 'android')",
    );
    expect(normalized).not.toContain(".bun/");
  });

  it("is idempotent", () => {
    const generated = `project(':capacitor-android').projectDir = new File('../../node_modules/@capacitor/android/capacitor')\n`;
    const once = normalizeCapacitorSettings(generated);
    expect(normalizeCapacitorSettings(once)).toBe(once);
  });
});
