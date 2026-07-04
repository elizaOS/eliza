/** Rollup config that wraps the tsc ESM output into IIFE + CJS `dist/plugin` bundles with dynamic imports inlined; `@capacitor/core` and `llama-cpp-capacitor` stay external. */

export default {
  input: "dist/esm/index.js",
  output: [
    {
      file: "dist/plugin.js",
      format: "iife",
      name: "capacitorLlama",
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
  external: ["@capacitor/core", "llama-cpp-capacitor"],
  onwarn(warning, warn) {
    if (
      warning.code === "THIS_IS_UNDEFINED" &&
      String(warning.id ?? "").endsWith("dist/esm/capacitor-llama-adapter.js")
    ) {
      return;
    }
    warn(warning);
  },
};
