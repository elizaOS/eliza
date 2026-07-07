/**
 * Bundles the tsc-compiled Desktop Capacitor plugin (`dist/esm/index.js`) into
 * the two artifact formats Capacitor consumers load: an IIFE for direct
 * `<script>` inclusion (`dist/plugin.js`) and CJS for bundler/Node consumption
 * (`dist/plugin.cjs.js`). `@capacitor/core` stays external so host apps supply
 * their own copy rather than bundling a second one.
 */
import nodeResolve from "@rollup/plugin-node-resolve";

const external = ["@capacitor/core"];

export default [
  {
    input: "dist/esm/index.js",
    output: [
      {
        file: "dist/plugin.js",
        format: "iife",
        name: "capacitorDesktop",
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
    external,
    plugins: [nodeResolve()],
  },
];
