/**
 * Bundles the compiled `dist/esm/index.js` into an IIFE (`dist/plugin.js`, for
 * script-tag/Electrobun consumption) and a CJS build (`dist/plugin.cjs.js`),
 * externalizing the `@capacitor/core` peer dependency so host apps supply their
 * own copy rather than bundling a second one.
 */
export default {
  input: "dist/esm/index.js",
  output: [
    {
      file: "dist/plugin.js",
      format: "iife",
      name: "capacitorLocation",
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
