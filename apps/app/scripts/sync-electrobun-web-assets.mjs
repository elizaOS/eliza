import { cp, mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, "..");
const sourceDir = path.join(appRoot, "dist");
const targetDir = path.join(appRoot, "electrobun", "app");
const LOG_PREFIX = "[Electrobun]";

async function ensureDirExists(dir) {
  try {
    const info = await stat(dir);
    return info.isDirectory();
  } catch {
    return false;
  }
}

if (!(await ensureDirExists(sourceDir))) {
  console.error(`${LOG_PREFIX} Web build output not found: ${sourceDir}`);
  console.error(
    `${LOG_PREFIX} Run \`bun run build\` from apps/app before syncing Electrobun assets.`,
  );
  process.exit(1);
}

await rm(targetDir, { recursive: true, force: true });
await mkdir(targetDir, { recursive: true });
await cp(sourceDir, targetDir, { recursive: true, force: true });

console.info(`${LOG_PREFIX} Synced web assets: ${sourceDir} -> ${targetDir}`);
