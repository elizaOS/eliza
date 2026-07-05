/**
 * Bundles the tsc output (`dist/esm/index.js`) into the two artifacts the
 * Capacitor host app consumes: an IIFE for browser `<script>` inclusion and
 * a CJS build for Node-based tooling. `@capacitor/core` stays external since
 * the host app supplies its own copy.
 */
export default {
  input: "dist/esm/index.js",
  output: [
    {
      file: "dist/plugin.js",
      format: "iife",
      name: "capacitorPhone",
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
