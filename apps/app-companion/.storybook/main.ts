import path from "node:path";
import type { StorybookConfig } from "@storybook/react-vite";

const companionRoot = path.resolve(__dirname, "..");
const elizaRoot = path.resolve(companionRoot, "../..");

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
      "@elizaos/core": path.resolve(elizaRoot, "packages/core/src/index.ts"),
    };
    return config;
  },
};

export default config;
