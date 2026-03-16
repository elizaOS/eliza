import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const __dirname = dirname(fileURLToPath(import.meta.url));
const distDir = join(__dirname, "dist");

const shared = {
  entryPoints: {
    "index.node": join(__dirname, "index.node.ts"),
    "index.browser": join(__dirname, "index.browser.ts"),
  },
  bundle: true,
  sourcemap: true,
  external: ["@elizaos/core"],
};

async function buildAll() {
  console.log("Building Vercel AI Gateway plugin...");

  await build({
    ...shared,
    outdir: join(distDir, "node"),
    format: "esm",
    platform: "node",
    target: "node20",
  });

  await build({
    ...shared,
    outdir: join(distDir, "browser"),
    format: "esm",
    platform: "browser",
    target: "es2022",
  });

  await build({
    ...shared,
    outdir: join(distDir, "cjs"),
    format: "cjs",
    platform: "node",
    target: "node20",
    outExtension: { ".js": ".cjs" },
  });

  console.log("Build complete!");
}

buildAll().catch((error) => {
  console.error("Build failed:", error);
  process.exit(1);
});
