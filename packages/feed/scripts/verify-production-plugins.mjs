#!/usr/bin/env bun
/**
 * Verifies the Feed production image can load every elizaOS runtime plugin.
 *
 * The Feed loader imports these packages dynamically, so TypeScript can pass
 * even when Docker pruning omits the package bytes. Importing the installed
 * package exports here makes image construction enforce the runtime contract.
 */
import { anthropicPlugin } from "@elizaos/plugin-anthropic";
import { openaiPlugin } from "@elizaos/plugin-openai";
import { plugin as sqlPlugin } from "@elizaos/plugin-sql";

const requiredPlugins = [
  ["@elizaos/plugin-anthropic", anthropicPlugin],
  ["@elizaos/plugin-openai", openaiPlugin],
  ["@elizaos/plugin-sql", sqlPlugin],
];

for (const [packageName, plugin] of requiredPlugins) {
  if (!plugin || typeof plugin !== "object" || typeof plugin.name !== "string") {
    throw new Error(
      `[FeedProductionPlugins] ${packageName} did not export a named plugin object`,
    );
  }
  console.log(`[FeedProductionPlugins] loaded ${packageName} as ${plugin.name}`);
}
