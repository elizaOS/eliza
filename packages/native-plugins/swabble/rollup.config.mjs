import fs from "node:fs";
import nodeResolve from "@rollup/plugin-node-resolve";

const external = ["@capacitor/core"];
const input = fs.existsSync("dist/esm/index.js")
  ? "dist/esm/index.js"
  : "dist/esm/src/index.js";

export default [
  {
    input,
    output: [
      {
        file: "dist/plugin.js",
        format: "iife",
        name: "capacitorSwabble",
        globals: {
          "@capacitor/core": "capacitorExports",
        },
        sourcemap: true,
        inlineDynamicImports: true,
      },
      {
        file: "dist/plugin.cjs.js",
        format: "cjs",
        sourcemap: true,
        inlineDynamicImports: true,
      },
    ],
    external,
    plugins: [nodeResolve()],
  },
];
