import { execFileSync, spawn } from "node:child_process";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const nextCliPath = require.resolve("next/dist/bin/next");
const nextVersion = require("next/package.json").version;
const nextMajor = Number.parseInt(nextVersion.split(".")[0] ?? "0", 10);
const nextBuildArgs = ["build", ...(nextMajor >= 16 ? ["--webpack"] : [])];
const pkgRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const cleanupHelperPath = path.resolve(
  pkgRoot,
  "../../scripts/rm-path-recursive.mjs",
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

function rmRecursive(targetPath) {
  execFileSync(process.execPath, [cleanupHelperPath, targetPath], {
    cwd: pkgRoot,
    stdio: "inherit",
  });
}

rmRecursive(tempDistDir);
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
    const child = spawn(process.execPath, [nextCliPath, ...nextBuildArgs], {
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
    rmRecursive(finalDistDir);
    await rename(tempDistDir, finalDistDir);
  } else {
    rmRecursive(tempDistDir);
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
