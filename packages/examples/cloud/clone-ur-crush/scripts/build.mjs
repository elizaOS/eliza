import { spawn } from "node:child_process";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const nextCliPath = require.resolve("next/dist/bin/next");
const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const finalDistDir = path.join(packageRoot, ".next");
const tempDistDirName = ".next-build";
const tempDistDir = path.join(packageRoot, tempDistDirName);

const compatibilityFiles = [
  {
    file: path.join(tempDistDir, "server", "pages-manifest.json"),
    content: "{}\n",
  },
  {
    file: path.join(tempDistDir, "server", "middleware-manifest.json"),
    content: `${JSON.stringify(
      {
        version: 3,
        middleware: {},
        functions: {},
        sortedMiddleware: [],
      },
      null,
      2,
    )}\n`,
  },
  {
    file: path.join(tempDistDir, "server", "server-reference-manifest.json"),
    content: `${JSON.stringify(
      {
        node: {},
        edge: {},
        encryptionKey: "process.env.NEXT_SERVER_ACTIONS_ENCRYPTION_KEY",
      },
      null,
      2,
    )}\n`,
  },
  {
    file: path.join(tempDistDir, "server", "app-paths-manifest.json"),
    content: `${JSON.stringify(
      {
        "/api/analyze-photo/route": "app/api/analyze-photo/route.js",
        "/_not-found/page": "app/_not-found/page.js",
        "/api/create-character/route": "app/api/create-character/route.js",
        "/api/generate-field/route": "app/api/generate-field/route.js",
        "/api/generate-photo/route": "app/api/generate-photo/route.js",
        "/api/generate-scene/route": "app/api/generate-scene/route.js",
        "/cloning/page": "app/cloning/page.js",
        "/page": "app/page.js",
      },
      null,
      2,
    )}\n`,
  },
  {
    file: path.join(
      tempDistDir,
      "server",
      "app",
      "_not-found",
      "page.js.nft.json",
    ),
    content: '{"version":1,"files":[]}\n',
  },
  ...[
    "api/analyze-photo/route.ts",
    "api/create-character/route.ts",
    "api/generate-field/route.ts",
    "api/generate-photo/route.ts",
    "api/generate-scene/route.ts",
    "cloning/page.ts",
    "layout.ts",
    "page.ts",
  ].map((relativeFile) => ({
    file: path.join(tempDistDir, "types", "app", relativeFile),
    content: "export {};\n",
  })),
];

async function writeIfMissing(file, content) {
  const existing = await readFile(file, "utf8").catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });

  if (existing !== null) return;

  await mkdir(path.dirname(file), { recursive: true });
  const tempFile = `${file}.${process.pid}.tmp`;
  await writeFile(tempFile, content);
  await rename(tempFile, file);
}

async function writeCompatibilityFiles() {
  await Promise.all(
    compatibilityFiles.map(({ file, content }) =>
      writeIfMissing(file, content),
    ),
  );
}

await rm(tempDistDir, {
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
    env: {
      ...process.env,
      NEXT_DIST_DIR: tempDistDirName,
    },
    stdio: "inherit",
  });

  child.on("close", (code) => {
    clearInterval(markerInterval);
    resolve(code ?? 1);
  });
});

if (exitCode === 0) {
  await rm(finalDistDir, {
    force: true,
    maxRetries: 5,
    recursive: true,
    retryDelay: 100,
  });
  await rename(tempDistDir, finalDistDir);
} else {
  await rm(tempDistDir, {
    force: true,
    maxRetries: 5,
    recursive: true,
    retryDelay: 100,
  });
}

process.exit(exitCode);
