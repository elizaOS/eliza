#!/usr/bin/env bun
/**
 * Build script for @elizaos/plugin-openai (Node + Browser).
 * Orchestration lives in the shared driver; this lists only what differs.
 */
import { buildPlugin } from "../plugin-build";

// Single-quoted re-export to keep the emitted .d.ts byte-stable.
const reexport = "export * from '../index';\nexport { default } from '../index';\n";
const endpointDeclaration = `import type { IAgentRuntime } from "@elizaos/core";
export type EndpointSettingReader = (key: string) => string | undefined;
export declare function isCerebrasMode(runtime: IAgentRuntime): boolean;
export declare function resolveOpenAIBaseURL(
  readSetting: EndpointSettingReader,
  options?: { browser?: boolean; mockBaseURL?: string },
): string;
`;

await buildPlugin({
  name: "@elizaos/plugin-openai",
  targets: [
    { label: "Node", entry: "index.node.ts", outSubdir: "node", target: "node", format: "esm" },
    {
      label: "Browser",
      entry: "index.browser.ts",
      outSubdir: "browser",
      target: "browser",
      format: "esm",
      minify: true,
    },
    {
      label: "Endpoint config",
      entry: "utils/config.ts",
      outSubdir: "",
      target: "node",
      format: "esm",
      naming: { entry: "endpoint-config.[ext]" },
    },
  ],
  dtsProject: "tsconfig.build.json",
  dtsShims: [
    { path: "node/index.d.ts", content: reexport },
    { path: "browser/index.d.ts", content: reexport },
    { path: "endpoint-config.d.ts", content: endpointDeclaration },
  ],
});
