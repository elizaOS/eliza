/**
 * Verifies that the LifeOps mock redirect stays limited to connectors whose
 * production clients support alternate HTTP bases. Personal Google Workspace
 * must continue through the official MCP resources even in scenario runs.
 */
import { describe, expect, it } from "vitest";
import { applyMockoonEnvOverrides } from "./mockoon-redirect";

describe("applyMockoonEnvOverrides", () => {
  it("does not redirect personal Google Workspace", () => {
    const env: NodeJS.ProcessEnv = {
      LIFEOPS_USE_MOCKOON: "1",
    };

    const applied = applyMockoonEnvOverrides(env);

    expect(applied).not.toContain("gmail");
    expect(applied).not.toContain("calendar");
    expect(env.ELIZA_MOCK_TWILIO_BASE).toBe("http://127.0.0.1:18808");
  });
});
