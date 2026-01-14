import { describe, expect, it } from "vitest";
import { experiencePlugin } from "../index";

describe("plugin-experience", () => {
  it("exports plugin metadata", () => {
    expect(experiencePlugin.name).toBe("experience");
    expect(experiencePlugin.description).toContain("experience");
  });

  it("registers core components", () => {
    expect(experiencePlugin.services?.length).toBeGreaterThan(0);
    expect(experiencePlugin.providers?.length).toBeGreaterThan(0);
    expect(experiencePlugin.evaluators?.length).toBeGreaterThan(0);
    expect(experiencePlugin.actions?.length).toBeGreaterThan(0);
  });
});
