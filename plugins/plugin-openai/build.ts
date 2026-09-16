#!/usr/bin/env bun
/** Build the Node provider and its host endpoint configuration entry. */
import { buildPlugin } from "../plugin-build";
await buildPlugin({
  name: "@elizaos/plugin-openai",
  targets: [
    { label: "Node", entry: "index.ts", outSubdir: "", target: "node", format: "esm" },
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
    {
      path: "endpoint-config.d.ts",
      content:
        'export { isCerebrasMode, resolveOpenAIBaseURL, type EndpointSettingReader } from "./utils/config.js";\n',
    },
  ],
});
