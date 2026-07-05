/**
 * Rollup config bundling the tsc-emitted ESM output into the two artifacts
 * Capacitor plugins ship: an IIFE for browser `<script>`/bundler globals and
 * a CJS build for Node tooling. `inlineDynamicImports` folds the lazy
 * `import("./web")` in `index.ts` into each bundle so there is no separate
 * chunk to resolve at load time.
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
        name: "capacitorMessages",
        globals: { "@capacitor/core": "capacitorExports" },
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
