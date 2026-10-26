/** `plugins.deny` and ELIZA_SKIP_PLUGINS accept the same ids as `plugins.allow`. */
import type { ElizaConfig } from "@elizaos/host/protocol";
import { expect, it } from "vitest";
import {
  collectDeniedPluginNames,
  collectPluginNames,
} from "../src/runtime/plugin-collector.ts";

it("denies a loaded plugin by short id, channel name or package name", () => {
  const config: ElizaConfig = {
    plugins: {
      allow: ["@elizaos/plugin-discord", "@elizaos/plugin-x", "openai"],
    },
  };
  const loaded = collectPluginNames(config);
  for (const name of [
    "@elizaos/plugin-discord",
    "@elizaos/plugin-x",
    "@elizaos/plugin-openai",
  ]) {
    expect(loaded.has(name)).toBe(true);
  }

  const denied = collectDeniedPluginNames([
    "discord",
    "twitter",
    "@elizaos/plugin-openai",
    "my-drop-in",
  ]);
  const remaining = [...loaded].filter((name) => !denied.has(name));

  expect(remaining).not.toContain("@elizaos/plugin-discord");
  expect(remaining).not.toContain("@elizaos/plugin-x");
  expect(remaining).not.toContain("@elizaos/plugin-openai");
  // Unscoped drop-in names are still matched as written.
  expect(denied.has("my-drop-in")).toBe(true);
});
