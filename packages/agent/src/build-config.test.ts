/**
 * Guards the agent's production emit boundary against traversing into sibling
 * workspace sources, which would leave JavaScript beside their TypeScript.
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

interface BuildConfig {
  compilerOptions?: {
    paths?: Record<string, string[]>;
  };
}

describe("agent build configuration", () => {
  it("resolves app-manager declarations from its build output", async () => {
    const configPath = fileURLToPath(
      new URL("../tsconfig.build.json", import.meta.url),
    );
    const config = JSON.parse(
      await readFile(configPath, "utf8"),
    ) as BuildConfig;

    expect(
      config.compilerOptions?.paths?.["@elizaos/plugin-app-manager"],
    ).toEqual(["../../plugins/plugin-app-manager/dist/index.d.ts"]);
  });
});
