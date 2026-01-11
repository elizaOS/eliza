import { mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { build } from "bun";

async function cleanDist() {
  try {
    await rm("./dist", { recursive: true, force: true });
    await mkdir("./dist", { recursive: true });
  } catch {
    // Ignore if dist doesn't exist
  }
}

async function getSourceFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await getSourceFiles(fullPath)));
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      files.push(fullPath);
    }
  }

  return files;
}

async function main() {
  console.log("Building plugin-planning TypeScript package...");

  await cleanDist();

  const sourceFiles = await getSourceFiles("./src");
  console.log(`Found ${sourceFiles.length} source files`);

  await build({
    entrypoints: sourceFiles,
    outdir: "./dist",
    format: "esm",
    target: "node",
    splitting: true,
    sourcemap: "external",
    external: ["@elizaos/core", "@elizaos/plugin-sql", "uuid"],
  });

  console.log("Build completed successfully!");
}

main().catch(console.error);
