import pluginConfig from "@elizaos/config/eslint/eslint.config.plugin.js";

export default [
  ...pluginConfig,
  {
    ignores: ["dist/", "node_modules/", "src/data/defaultNodes.json"],
  },
];
