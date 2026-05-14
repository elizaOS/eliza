import fs from "node:fs";
import path from "node:path";

export async function getViteOutDir(packageRoot: string): Promise<string> {
  const viteConfigPath = path.join(packageRoot, "vite.config.ts");

  if (!fs.existsSync(viteConfigPath)) {
    throw new Error(`vite.config.ts not found at ${viteConfigPath}`);
  }

  const configModule = await import(viteConfigPath);
  const config =
    typeof configModule.default === "function"
      ? configModule.default({ command: "build", mode: "production" })
      : configModule.default;

  let outDir = config.build?.outDir || "dist";
  const viteRoot = config.root || ".";

  if (!path.isAbsolute(outDir)) {
    const viteRootAbsolute = path.resolve(packageRoot, viteRoot);
    outDir = path.resolve(viteRootAbsolute, outDir);
  }

  return path.relative(packageRoot, outDir);
}
