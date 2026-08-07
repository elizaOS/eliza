#!/usr/bin/env bun
/**
 * Defines the Node and browser package builds for the Fish Audio plugin while
 * delegating orchestration to the repository's shared plugin build driver.
 */
import { buildPlugin } from "../plugin-build";

const reexport =
  "export * from '../index';\nexport { default } from '../index';\n";

await buildPlugin({
  name: "@elizaos/plugin-fish-audio",
  targets: [
    {
      label: "Node",
      entry: "index.node.ts",
      outSubdir: "node",
      target: "node",
      format: "esm",
    },
    {
      label: "Browser",
      entry: "index.browser.ts",
      outSubdir: "browser",
      target: "browser",
      format: "esm",
    },
  ],
  dtsProject: "tsconfig.build.json",
  dtsShims: [
    { path: "node/index.d.ts", content: reexport },
    { path: "browser/index.d.ts", content: reexport },
  ],
});
