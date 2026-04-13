import type { StorybookConfig } from "@storybook/react-vite";
import path from "node:path";

const companionRoot = path.resolve(import.meta.dirname, "..");
const elizaRoot = path.resolve(companionRoot, "../..");
const miladyRoot = path.resolve(elizaRoot, "../..");

const config: StorybookConfig = {
  stories: ["../src/**/*.stories.@(ts|tsx)"],
  addons: [
    "@storybook/addon-essentials",
    "@storybook/addon-a11y",
    "@storybook/addon-themes",
  ],
  framework: {
    name: "@storybook/react-vite",
    options: {},
  },
  docs: {
    autodocs: "tag",
  },
  staticDirs: ["../public"],
  viteFinal: async (config) => {
    config.resolve ??= {};
    config.resolve.alias = {
      ...(config.resolve.alias ?? {}),
      "@elizaos/app-core": path.resolve(
        elizaRoot,
        "packages/app-core/src/index.ts",
      ),
      "@elizaos/core": path.resolve(
        elizaRoot,
        "packages/typescript/src/index.ts",
      ),
    };
    return config;
  },
};

export default config;
