/**
 * Verifies Eliza Cloud inference and diagnostic endpoint resolution share the
 * same whitespace and process-environment fallback contract.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getBaseURL, resolveElizaCloudBaseURL } from "../../src/utils/config";

afterEach(() => vi.unstubAllEnvs());

describe("Eliza Cloud endpoint config", () => {
  it("falls through whitespace runtime config to valid process env", () => {
    vi.stubEnv("ELIZAOS_CLOUD_BASE_URL", " https://process.cloud.example/api/v1 ");
    const runtime = {
      getSetting: (key: string) => (key === "ELIZAOS_CLOUD_BASE_URL" ? "   " : null),
    } as IAgentRuntime;

    const inferred = getBaseURL(runtime);
    const diagnosed = resolveElizaCloudBaseURL((key) => process.env[key]);

    expect(inferred).toBe("https://process.cloud.example/api/v1");
    expect(diagnosed).toBe(inferred);
  });
});
