/**
 * Bundles the tsc-emitted ESM (`dist/esm/index.js`) into the two artifacts
 * Capacitor host apps consume: an IIFE for direct `<script>`/bundler use and
 * a CJS build for Node tooling. `@capacitor/core` stays external — hosts
 * supply their own copy — and `inlineDynamicImports` folds the web fallback's
 * dynamic `import("./web")` into each bundle so lazy-loading still works
 * once flattened to a single file.
 */
export default {
  input: "dist/esm/index.js",
  output: [
    {
      file: "dist/plugin.js",
      format: "iife",
      name: "capacitorTalkMode",
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
