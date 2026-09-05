/**
 * Generated native Capacitor package build configuration. Change the scaffold
 * manifest or generator instead of editing this file directly.
 */
import nodeResolve from "@rollup/plugin-node-resolve";

export default [
  {
    input: "dist/esm/index.js",
    output: [
      {
        file: "dist/plugin.js",
        format: "iife",
        name: "capacitorDesktop",
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
    plugins: [nodeResolve()],
  },
];
