/**
 * Verifies that both published OpenAI plugin metadata surfaces keep direct API
 * credentials optional because compatible providers and authenticated proxies
 * are valid alternatives. The test reads the real JSON artifacts without mocks.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function readJson(relativePath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(new URL(relativePath, import.meta.url), "utf8")) as Record<
    string,
    unknown
  >;
}

describe("OpenAI authentication metadata", () => {
  it("does not require OPENAI_API_KEY in package or registry metadata", () => {
    const packageManifest = readJson("../package.json") as {
      agentConfig?: {
        pluginParameters?: Record<string, { required?: boolean }>;
      };
    };
    const registryEntry = readJson("../registry-entry.json") as {
      config?: Record<string, { required?: boolean }>;
    };

    expect(packageManifest.agentConfig?.pluginParameters?.OPENAI_API_KEY?.required).toBe(false);
    expect(registryEntry.config?.OPENAI_API_KEY?.required).toBe(false);
  });
});
