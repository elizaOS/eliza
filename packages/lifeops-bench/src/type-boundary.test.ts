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

const REQUIRED_TYPE_PATHS = {
  "@elizaos/agent/runtime/core-plugins": [
    "../agent/dist/runtime/core-plugins.d.ts",
  ],
  "@elizaos/agent/runtime/plugin-types": [
    "../agent/dist/runtime/plugin-types.d.ts",
  ],
  "@elizaos/plugin-local-inference/runtime": [
    "../../plugins/plugin-local-inference/dist/runtime/index.d.ts",
  ],
  "@elizaos/plugin-personal-assistant": [
    "../../plugins/plugin-personal-assistant/dist/index.d.ts",
  ],
  "@elizaos/plugin-personal-assistant/lifeops/owner/fact-store": [
    "../../plugins/plugin-personal-assistant/dist/lifeops/owner/fact-store.d.ts",
  ],
};

const FORBIDDEN_BROAD_TYPE_PATHS = [
  "@elizaos/agent",
  "@elizaos/agent/*",
  "@elizaos/plugin-local-inference",
  "@elizaos/plugin-local-inference/*",
] as const;

describe("LifeOps bench type boundary", () => {
  it("keeps agent imports on the required built declaration boundary", () => {
    const configPath = fileURLToPath(
      new URL("../tsconfig.json", import.meta.url),
    );
    const config = JSON.parse(
      readFileSync(configPath, "utf8"),
    ) as BenchTypeScriptConfig;
    const configuredPaths = config.compilerOptions?.paths;

    expect(configuredPaths).toBeDefined();
    if (!configuredPaths) {
      throw new Error(
        "LifeOps bench tsconfig must declare compiler path mappings",
      );
    }

    expect(configuredPaths).toMatchObject(REQUIRED_TYPE_PATHS);
    expect(
      FORBIDDEN_BROAD_TYPE_PATHS.filter(
        (mapping) => mapping in configuredPaths,
      ),
    ).toEqual([]);
  });
});
