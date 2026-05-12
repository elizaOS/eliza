import { spawn } from "node:child_process";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const nextCliPath = require.resolve("next/dist/bin/next");
const pkgRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const finalDistDir = ".next";
const tempDistDir = ".next-build";
const tempPackagePath = path.join(tempDistDir, "package.json");
const tempPackageWritePath = path.join(tempDistDir, ".package.json.tmp");
const tempCompatibilityFiles = [
  {
    file: path.join(tempDistDir, "server", "pages-manifest.json"),
    content: "{}\n",
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
];
const nextEnvPath = "next-env.d.ts";
const tsconfigPath = "tsconfig.json";
const tsbuildInfoPath = "tsconfig.tsbuildinfo";
const originalNextEnv = await readFile(nextEnvPath, "utf8").catch((error) => {
  if (error?.code === "ENOENT") {
    return null;
  }

  throw error;
});
const originalTsconfig = await readFile(tsconfigPath, "utf8").catch((error) => {
  if (error?.code === "ENOENT") {
    return null;
  }

  throw error;
});

await rm(tempDistDir, {
  force: true,
  maxRetries: 5,
  recursive: true,
  retryDelay: 100,
});
await rm(tsbuildInfoPath, {
  force: true,
  maxRetries: 5,
  retryDelay: 100,
});

async function writeTempPackageMarker() {
  await mkdir(path.dirname(tempPackagePath), { recursive: true });
  await writeFile(tempPackageWritePath, '{"type":"commonjs"}\n');
  await rename(tempPackageWritePath, tempPackagePath);
}

async function writeIfMissing(file, content) {
  const existing = await readFile(file, "utf8").catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (existing !== null) return;
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
}

async function writeBuildCompatibilityFiles() {
  await writeTempPackageMarker();
  await Promise.all(
    tempCompatibilityFiles.map(({ file, content }) =>
      writeIfMissing(file, content),
    ),
  );
}

let exitCode = 1;
let markerWrite = null;

function refreshTempPackageMarker() {
  markerWrite ??= writeBuildCompatibilityFiles().finally(() => {
    markerWrite = null;
  });
  return markerWrite;
}

try {
  await refreshTempPackageMarker();
  exitCode = await new Promise((resolve) => {
    const markerInterval = setInterval(() => {
      void refreshTempPackageMarker().catch(() => {});
    }, 100);
    const child = spawn(process.execPath, [nextCliPath, "build"], {
      cwd: pkgRoot,
      env: {
        ...process.env,
        NEXT_DIST_DIR: tempDistDir,
        // Avoid booting AgentRuntime + DB during static analysis / route collection.
        NEXT_BUILD_SKIP_RUNTIME: "1",
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
} finally {
  if (originalNextEnv !== null) {
    await writeFile(nextEnvPath, originalNextEnv);
  }
  if (originalTsconfig !== null) {
    await writeFile(tsconfigPath, originalTsconfig);
  }
  await rm(tsbuildInfoPath, {
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
}

process.exit(exitCode);
