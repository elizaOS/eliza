/**
 * Unit tests for config-env: validates reading env keys with process.env fallbacks.
 */
import { describe, expect, it } from "vitest";
import { readConfigCloudKey, readConfigEnvKey } from "./config-env.ts";

describe("config-env", () => {
  it("reads fallback key from process.env when present", () => {
    process.env.TEST_ELIZA_ORCHESTRATOR_KEY = "test-val-123";
    expect(readConfigEnvKey("TEST_ELIZA_ORCHESTRATOR_KEY")).toBe(
      "test-val-123",
    );
    delete process.env.TEST_ELIZA_ORCHESTRATOR_KEY;
  });

  it("returns undefined for non-existent config keys", () => {
    expect(readConfigEnvKey("DEFINITELY_NON_EXISTENT_ENV_KEY")).toBeUndefined();
    expect(
      readConfigCloudKey("DEFINITELY_NON_EXISTENT_CLOUD_KEY"),
    ).toBeUndefined();
  });
});
