/** Builds the Fish Audio plugin for node and browser package entrypoints. */

await Bun.build({
  entrypoints: ["index.node.ts"],
  outdir: "dist/node",
  target: "node",
  format: "esm",
  sourcemap: "external",
});

await Bun.build({
  entrypoints: ["index.browser.ts"],
  outdir: "dist/browser",
  target: "browser",
  format: "esm",
  sourcemap: "external",
});

const declaration = Bun.spawnSync(["tsc", "-p", "tsconfig.build.json"]);
if (!declaration.success) {
  process.stderr.write(declaration.stderr);
  process.exit(declaration.exitCode ?? 1);
}
