import { existsSync, mkdirSync, rmSync } from "node:fs";
import { build } from "bun";

const outdir = "./dist";

if (existsSync(outdir)) {
  rmSync(outdir, { recursive: true });
}
mkdirSync(outdir, { recursive: true });
mkdirSync(`${outdir}/node`, { recursive: true });

console.log("Building RSS plugin...");

const nodeResult = await build({
  entrypoints: ["./index.ts"],
  outdir: `${outdir}/node`,
  target: "node",
  format: "esm",
  sourcemap: "linked",
  external: ["@elizaos/core"],
  naming: "index.node.js",
});

if (!nodeResult.success) {
  console.error("Node build failed:");
  for (const log of nodeResult.logs) {
    console.error(log);
  }
  process.exit(1);
}

console.log("Build completed successfully!");
console.log(`Output: ${outdir}/`);
