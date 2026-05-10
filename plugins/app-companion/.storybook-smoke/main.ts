import path from "node:path";
import type { StorybookConfig } from "@storybook/react-vite";

const companionRoot = path.resolve(__dirname, "..");
const elizaRoot = path.resolve(companionRoot, "../..");

const config: StorybookConfig = {
  stories: [
    "../src/components/chat/ChatAvatar.stories.tsx",
    "../src/components/companion/InferenceCloudAlertButton.stories.tsx",
    "../src/components/companion/shell-control-styles.stories.tsx",
  ],
  addons: [
    "@storybook/addon-essentials",
    "@storybook/addon-a11y",
    "@storybook/addon-themes",
  ],
  typescript: {
    reactDocgen: false,
  },
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
      "@elizaos/app-core": path.resolve(elizaRoot, "packages/app-core/src"),
      "@elizaos/core": path.resolve(elizaRoot, "packages/core/src"),
      "@elizaos/ui": path.resolve(elizaRoot, "packages/ui/src"),
    };
    return config;
  },
};

export default config;
