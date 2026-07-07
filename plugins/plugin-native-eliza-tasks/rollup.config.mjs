/**
 * Bundles the compiled `dist/esm/index.js` into an IIFE (`dist/plugin.js`,
 * global `capacitorElizaTasks`) and a CJS build (`dist/plugin.cjs.js`) —
 * the two formats Capacitor's web/Electron targets load. `@capacitor/core`
 * stays external; the host app provides it at runtime.
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
        name: "capacitorElizaTasks",
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
