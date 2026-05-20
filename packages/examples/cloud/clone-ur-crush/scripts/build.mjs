import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const nextCliPath = require.resolve("next/dist/bin/next");
const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const distDir = path.join(packageRoot, ".next");

const compatibilityFiles = [
  {
    file: path.join(distDir, "server", "pages-manifest.json"),
    content: "{}\n",
  },
];

async function writeIfMissing(file, content) {
  const existing = await readFile(file, "utf8").catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });

  if (existing !== null) return;

  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
}

async function writeCompatibilityFiles() {
  await Promise.all(
    compatibilityFiles.map(({ file, content }) => writeIfMissing(file, content)),
  );
}

await rm(distDir, {
  force: true,
  maxRetries: 5,
  recursive: true,
  retryDelay: 100,
});

let markerWrite = null;
function refreshCompatibilityFiles() {
  markerWrite ??= writeCompatibilityFiles().finally(() => {
    markerWrite = null;
  });
  return markerWrite;
}

await refreshCompatibilityFiles();

const exitCode = await new Promise((resolve) => {
  const markerInterval = setInterval(() => {
    void refreshCompatibilityFiles().catch(() => {});
  }, 100);

  const child = spawn(process.execPath, [nextCliPath, "build"], {
    cwd: packageRoot,
    stdio: "inherit",
  });

  child.on("close", (code) => {
    clearInterval(markerInterval);
    resolve(code ?? 1);
  });
});

process.exit(exitCode);
