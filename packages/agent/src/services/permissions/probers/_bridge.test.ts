/**
 * Covers the embedded provisioning-profile entitlement gate used by the Health
 * and Screen Time probers. A missing profile means "unsigned dev build" and is
 * legitimately `false`; a profile that exists but cannot be read is a fault and
 * must not be reported as "this build is not entitled".
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hasEmbeddedProvisioningEntitlement } from "./_bridge.js";

const ENTITLEMENT = "com.apple.developer.healthkit";

const created: string[] = [];

/** Lay out a minimal `.app` bundle and return the path to its `MacOS/` binary. */
function fakeBundle(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "eliza-provisioning-"));
  created.push(root);
  const contents = path.join(root, "Eliza.app", "Contents");
  mkdirSync(path.join(contents, "MacOS"), { recursive: true });
  const binary = path.join(contents, "MacOS", "eliza");
  writeFileSync(binary, "");
  return binary;
}

function profilePathFor(binary: string): string {
  return path.join(
    path.dirname(path.dirname(binary)),
    "embedded.provisionprofile",
  );
}

afterEach(() => {
  while (created.length > 0) {
    const dir = created.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("hasEmbeddedProvisioningEntitlement", () => {
  it("returns false when the bundle has no embedded profile (unsigned dev build)", () => {
    const binary = fakeBundle();
    expect(hasEmbeddedProvisioningEntitlement(ENTITLEMENT, binary)).toBe(false);
  });

  it("finds a granted entitlement in the embedded profile", () => {
    const binary = fakeBundle();
    writeFileSync(
      profilePathFor(binary),
      `<?xml version="1.0"?><plist><dict><key>${ENTITLEMENT}</key><true/></dict></plist>`,
    );
    expect(hasEmbeddedProvisioningEntitlement(ENTITLEMENT, binary)).toBe(true);
  });

  it("returns false when the profile exists but does not grant the entitlement", () => {
    const binary = fakeBundle();
    writeFileSync(
      profilePathFor(binary),
      "<plist><dict><key>com.apple.developer.family-controls</key><true/></dict></plist>",
    );
    expect(hasEmbeddedProvisioningEntitlement(ENTITLEMENT, binary)).toBe(false);
  });

  it("reports an unreadable profile instead of claiming the build is not entitled", () => {
    const binary = fakeBundle();
    // A directory at the profile path exists but can never be read as a file,
    // which forces the same `fs` failure an EACCES/damaged bundle would.
    mkdirSync(profilePathFor(binary));

    expect(() =>
      hasEmbeddedProvisioningEntitlement(ENTITLEMENT, binary),
    ).toThrow(/embedded provisioning profile/i);
  });
});
