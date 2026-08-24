/**
 * Coverage for tutorial-script.
 */
import { describe, expect, it } from "vitest";
import { buildTutorialScript, TUTORIAL_STEP_IDS } from "./tutorial-script.js";

describe("tutorial-script", () => {
  it("exposes step ids", () => {
    expect(TUTORIAL_STEP_IDS).toContain("welcome");
    expect(TUTORIAL_STEP_IDS).toContain("done");
  });
  it("builds script", () => {
    const s = buildTutorialScript("MyApp");
    expect(s.length).toBeGreaterThan(0);
    expect(s[0].text).toContain("MyApp");
    const s2 = buildTutorialScript("");
    expect(s2[0].text).toContain("Eliza");
  });
});
