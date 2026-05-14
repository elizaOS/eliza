import path from "node:path";
import { fileURLToPath } from "node:url";

type ProviderSdkShimPlugin = {
  name: string;
  enforce: "pre";
  resolveId(source: string): string | null;
};

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");
const anthropicShimPath = path.join(here, "shims", "ai-sdk-anthropic.ts");
const elizaCoreConnectorShimPath = path.join(
  here,
  "shims",
  "elizaos-core-connector.ts",
);

export const providerSdkAliases = [
  {
    find: /^@elizaos\/core$/,
    replacement: elizaCoreConnectorShimPath,
  },
  {
    find: /^@ai-sdk\/anthropic$/,
    replacement: anthropicShimPath,
  },
];

export function providerSdkShimPlugin(): ProviderSdkShimPlugin {
  return {
    name: "provider-sdk-shims",
    enforce: "pre",
    resolveId(source) {
      if (source === "@elizaos/core") {
        return elizaCoreConnectorShimPath;
      }
      if (source === "@ai-sdk/anthropic") {
        return anthropicShimPath;
      }
      return null;
    },
  };
}

export { repoRoot };
