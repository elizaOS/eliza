/**
 * Bundles the compiled `dist/esm/index.js` into the two artifacts Capacitor
 * consumers load directly: an IIFE (`dist/plugin.js`, global
 * `capacitorBunRuntime`) for script-tag/webview use and a CJS build
 * (`dist/plugin.cjs.js`); `@capacitor/core` stays external in both.
 */
export default {
  input: "dist/esm/index.js",
  output: [
    {
      file: "dist/plugin.js",
      format: "iife",
      name: "capacitorBunRuntime",
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
