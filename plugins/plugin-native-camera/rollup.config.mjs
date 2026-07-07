/**
 * Rollup config bundling the compiled `dist/esm/index.js` into the browser
 * IIFE (`dist/plugin.js`) and CommonJS (`dist/plugin.cjs.js`) distributables;
 * `@capacitor/core` is left external for the host app to resolve.
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
        name: "capacitorElizaCamera",
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
