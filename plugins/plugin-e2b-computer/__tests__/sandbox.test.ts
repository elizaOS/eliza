import { describe, expect, it } from "vitest";
import { createDryRunDriver, resolveE2BDriver } from "../src/services/e2b-sandbox.ts";
import { readE2BConfig } from "../src/config.ts";

describe("plugin-e2b-computer", () => {
  it("dry-run driver executes without API key", async () => {
    const driver = createDryRunDriver();
    const session = await driver.create("code-interpreter-v1");
    const result = await driver.runCode(session.id, "print(42)");
    expect(result.dryRun).toBe(true);
    expect(result.error).toBeNull();
    expect(result.text).toContain("dry-run");
  });

  it("resolveE2BDriver falls back without key", async () => {
    const { mode } = await resolveE2BDriver({ apiKey: null });
    expect(mode).toBe("dry-run");
  });

  it("reads E2B_API_KEY from settings", () => {
    const cfg = readE2BConfig((k) => (k === "E2B_API_KEY" ? "e2b_test" : undefined));
    expect(cfg.apiKey).toBe("e2b_test");
    expect(cfg.enabled).toBe(true);
  });
});
