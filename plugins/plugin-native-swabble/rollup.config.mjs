import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import nodeResolve from "@rollup/plugin-node-resolve";

/**
 * Bundles the tsc output into the IIFE (`dist/plugin.js`) and CJS
 * (`dist/plugin.cjs.js`) artifacts the Capacitor host app consumes.
 * Resolves paths against this file's own directory rather than `cwd`
 * because turbo/bun may invoke rollup from the repo root.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const external = ["@capacitor/core"];

// Fails fast with an actionable message instead of a rollup "could not resolve" error
// if tsc hasn't run yet — this bundler step depends on the tsc step running first.
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
