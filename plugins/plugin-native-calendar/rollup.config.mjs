/**
 * Bundles the tsc-emitted `dist/esm/index.js` into the CJS
 * (`dist/plugin.cjs.js`) and IIFE (`dist/plugin.js`, for unpkg) artifacts
 * consumers outside the ESM/bun export condition load.
 */
export default {
  input: "dist/esm/index.js",
  output: [
    {
      file: "dist/plugin.js",
      format: "iife",
      name: "capacitorAppleCalendar",
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
