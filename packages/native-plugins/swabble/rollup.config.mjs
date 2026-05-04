import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import nodeResolve from "@rollup/plugin-node-resolve";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const external = ["@capacitor/core"];

// Resolve against this file's directory — turbo/bun may not use the package root as cwd.
const esmIndex = path.join(__dirname, "dist/esm/index.js");
if (!fs.existsSync(esmIndex)) {
  throw new Error(
    `[@elizaos/capacitor-swabble] Missing ${esmIndex}. Run tsc before rollup (expected rootDir src → dist/esm/index.js).`,
  );
}
const input = esmIndex;

export default [
  {
    input,
    output: [
      {
        file: path.join(__dirname, "dist/plugin.js"),
        format: "iife",
        name: "capacitorSwabble",
        globals: {
          "@capacitor/core": "capacitorExports",
        },
        sourcemap: true,
        inlineDynamicImports: true,
      },
      {
        file: path.join(__dirname, "dist/plugin.cjs.js"),
        format: "cjs",
        sourcemap: true,
        inlineDynamicImports: true,
      },
    ],
    external,
    plugins: [nodeResolve()],
  },
];
