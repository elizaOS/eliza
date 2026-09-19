/** Rollup config that wraps the tsc ESM output into IIFE + CJS `dist/plugin` bundles with dynamic imports inlined; native bindings and shared framework contracts stay external. */

export default {
  input: "dist/esm/index.js",
  output: [
    {
      file: "dist/plugin.js",
      format: "iife",
      name: "capacitorLlama",
      globals: {
        "@capacitor/core": "capacitorExports",
        "llama-cpp-capacitor": "llamaCppCapacitor",
        "@elizaos/core": "elizaCore",
        "@elizaos/shared/local-inference": "elizaLocalInference",
        "@elizaos/shared/local-inference/bge-input": "elizaBgeInput",
      },
      sourcemap: true,
      inlineDynamicImports: true,
    },
    {
      file: "dist/plugin.cjs",
      format: "cjs",
      sourcemap: true,
      inlineDynamicImports: true,
    },
  ],
  external: [
    "@capacitor/core",
    "llama-cpp-capacitor",
    "@elizaos/core",
    "@elizaos/shared/local-inference",
    "@elizaos/shared/local-inference/bge-input",
  ],
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
