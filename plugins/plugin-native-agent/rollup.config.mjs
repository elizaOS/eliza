/**
 * Bundles the tsc output (`dist/esm/index.js`) into a browser IIFE
 * (`dist/plugin.js`, global `capacitorAgent`) and a CJS build
 * (`dist/plugin.cjs.js`) for the Capacitor plugin registry and `require()`
 * consumers; `@capacitor/core` is left external for both targets.
 */
export default {
  input: "dist/esm/index.js",
  output: [
    {
      file: "dist/plugin.js",
      format: "iife",
      name: "capacitorAgent",
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
  external: ["@capacitor/core"],
};
