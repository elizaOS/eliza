/**
 * Rollup config bundling the tsc output (`dist/esm/index.js`) into the
 * IIFE (`dist/plugin.js`, global `capacitorContacts`) and CJS
 * (`dist/plugin.cjs.js`) artifacts Capacitor hosts load; `@capacitor/core`
 * is left external since the host app supplies it.
 */
export default {
  input: "dist/esm/index.js",
  output: [
    {
      file: "dist/plugin.js",
      format: "iife",
      name: "capacitorContacts",
      globals: { "@capacitor/core": "capacitorExports" },
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
