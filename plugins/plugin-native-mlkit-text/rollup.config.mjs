/**
 * Rollup config bundling the tsc-emitted ESM output into the IIFE and CJS
 * artifacts a Capacitor plugin ships. `inlineDynamicImports` folds the lazy
 * `import("./web")` in `index.ts` into each bundle so there is no separate
 * chunk to resolve at load time.
 */
export default {
  input: "dist/esm/index.js",
  output: [
    {
      file: "dist/plugin.js",
      format: "iife",
      name: "capacitorMlKitText",
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
