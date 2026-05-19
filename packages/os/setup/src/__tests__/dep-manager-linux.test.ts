import { describe, expect, it } from "vitest";
import { detectLinuxDistro } from "../dependencies/dep-manager";

describe("detectLinuxDistro", () => {
  it("returns 'unknown' on non-Linux platforms", () => {
    if (process.platform !== "linux") {
      expect(detectLinuxDistro()).toBe("unknown");
    } else {
      // On Linux, detection must return one of the known families.
      expect([
        "debian",
        "fedora",
        "arch",
        "suse",
        "alpine",
        "unknown",
      ]).toContain(detectLinuxDistro());
    }
  });
});
