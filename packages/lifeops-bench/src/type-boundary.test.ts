/**
 * Guards the benchmark typecheck boundary from traversing the agent's optional-plugin source graph.
 * Runtime resolution still uses the agent package exports; only compile-time types use built declarations.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

interface BenchTypeScriptConfig {
  compilerOptions?: {
    paths?: Record<string, string[]>;
  };
}

describe("LifeOps bench type boundary", () => {
  it("resolves narrow agent imports through built declarations", () => {
    const configPath = fileURLToPath(
      new URL("../tsconfig.json", import.meta.url),
    );
    const config = JSON.parse(
      readFileSync(configPath, "utf8"),
    ) as BenchTypeScriptConfig;

    expect(config.compilerOptions?.paths).toEqual({
      "@elizaos/agent/runtime/core-plugins": [
        "../agent/dist/runtime/core-plugins.d.ts",
      ],
      "@elizaos/agent/runtime/plugin-types": [
        "../agent/dist/runtime/plugin-types.d.ts",
      ],
      "@elizaos/plugin-local-inference/runtime": [
        "../../plugins/plugin-local-inference/dist/runtime/index.d.ts",
      ],
    });
  });
});
