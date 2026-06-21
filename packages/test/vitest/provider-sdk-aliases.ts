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
// @elizaos/logger was extracted from @elizaos/core, whose source still re-exports
// it (`export * from "@elizaos/logger"`). The connector shim replaces
// @elizaos/core, but `vi.mock("@elizaos/core", importOriginal)` still loads the
// real core, which pulls @elizaos/logger — whose dist isn't built in the keyless
// Plugin Tests lane. Resolve it to source (mirrors packages/test/vitest/default.config).
const loggerSourceEntry = path.join(
  here,
  "..",
  "..",
  "logger",
  "src",
  "index.ts",
);

export const providerSdkAliases = [
  {
    find: /^@elizaos\/core$/,
    replacement: elizaCoreConnectorShimPath,
  },
  {
    find: /^@elizaos\/logger$/,
    replacement: loggerSourceEntry,
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
      if (source === "@elizaos/logger") {
        return loggerSourceEntry;
      }
      if (source === "@ai-sdk/anthropic") {
        return anthropicShimPath;
      }
      return null;
    },
  };
}

export { repoRoot };
