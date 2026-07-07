/**
 * Bundles the compiled `dist/esm/index.js` into an IIFE (`dist/plugin.js`,
 * for CDN/`unpkg` consumers) and a CJS build (`dist/plugin.cjs.js`, for Node
 * consumers); `@capacitor/core` stays external since host apps provide it.
 */
export default {
  input: "dist/esm/index.js",
  output: [
    {
      file: "dist/plugin.js",
      format: "iife",
      name: "capacitorAppBlocker",
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
