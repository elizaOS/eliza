import { describe, expect, it } from "vitest";
import blueSkyPlugin from "../../index";

describe("BlueSky Plugin", () => {
  it("should have correct plugin metadata", () => {
    expect(blueSkyPlugin.name).toBe("bluesky");
    expect(blueSkyPlugin.description).toContain("BlueSky");
  });

  it("should export services", () => {
    expect(blueSkyPlugin.services).toBeDefined();
    expect(blueSkyPlugin.services?.length).toBeGreaterThan(0);
  });

  it("should have tests defined", () => {
    expect(blueSkyPlugin.tests).toBeDefined();
    expect(blueSkyPlugin.tests?.length).toBeGreaterThan(0);
  });

  it("should have config defined", () => {
    expect(blueSkyPlugin.config).toBeDefined();
  });

  it("should have init function", () => {
    expect(typeof blueSkyPlugin.init).toBe("function");
  });
});
