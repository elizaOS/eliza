/**
 * Bundles the compiled ESM output into the IIFE and CJS artifacts Capacitor
 * plugin consumers expect (`dist/plugin.js` for unpkg, `dist/plugin.cjs.js`
 * for CommonJS); `@capacitor/core` stays external and is resolved by the host
 * app at runtime.
 */
export default {
  input: "dist/esm/index.js",
  output: [
    {
      file: "dist/plugin.js",
      format: "iife",
      name: "capacitorGateway",
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
