/**
 * Bundles the compiled `dist/esm/index.js` output of the `ElizaCanvas`
 * Capacitor plugin into `dist/plugin.js` (IIFE, for `<script>`/unpkg
 * consumption) and `dist/plugin.cjs.js` (CommonJS); the ESM build comes
 * straight from `tsc` and isn't rolled up here.
 */

import nodeResolve from "@rollup/plugin-node-resolve";

const external = ["@capacitor/core"];

export default [
  {
    input: "dist/esm/index.js",
    output: [
      {
        file: "dist/plugin.js",
        format: "iife",
        name: "capacitorElizaCanvas",
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
