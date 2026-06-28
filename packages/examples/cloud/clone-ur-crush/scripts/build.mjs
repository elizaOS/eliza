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
const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const cleanupHelperPath = path.resolve(
  packageRoot,
  "../../../scripts/rm-path-recursive.mjs",
);
const finalDistDir = path.join(packageRoot, ".next");
const tempDistDirName = `.next-build-${process.pid}`;
const tempDistDir = path.join(packageRoot, tempDistDirName);
const tempPackagePath = path.join(tempDistDir, "package.json");
const tempPackageWritePath = path.join(tempDistDir, ".package.json.tmp");
const nextEnvPath = path.join(packageRoot, "next-env.d.ts");
const tsconfigPath = path.join(packageRoot, "tsconfig.json");
const tsbuildInfoPath = path.join(packageRoot, "tsconfig.tsbuildinfo");
const originalNextEnv = await readFile(nextEnvPath, "utf8").catch((error) => {
  if (error?.code === "ENOENT") return null;
  throw error;
});
const originalTsconfig = await readFile(tsconfigPath, "utf8").catch((error) => {
  if (error?.code === "ENOENT") return null;
  throw error;
});

function rmRecursive(targetPath) {
  execFileSync(process.execPath, [cleanupHelperPath, targetPath], {
    cwd: packageRoot,
    stdio: "inherit",
  });
}

rmRecursive(tempDistDir);

async function writeTempPackageMarker() {
  await mkdir(path.dirname(tempPackagePath), { recursive: true });
  await writeFile(tempPackageWritePath, '{"type":"commonjs"}\n');
  await rename(tempPackageWritePath, tempPackagePath);
}

async function writeTempTypesInclude() {
  if (originalTsconfig === null) return;

  const parsed = JSON.parse(originalTsconfig);
  const include = Array.isArray(parsed.include) ? parsed.include : [];
  const tempTypesGlob = `${tempDistDirName}/types/**/*.ts`;
  const tempTypesWildcard = ".next-build-*/types/**/*.ts";
  if (
    !include.includes(tempTypesGlob) &&
    !include.includes(tempTypesWildcard)
  ) {
    parsed.include = [...include, tempTypesGlob];
    await writeFile(
      `${tsconfigPath}.tmp`,
      `${JSON.stringify(parsed, null, 2)}\n`,
    );
    await rename(`${tsconfigPath}.tmp`, tsconfigPath);
  }
}

async function runNextBuild() {
  await writeTempPackageMarker();
  await writeTempTypesInclude();

  const exitCode = await new Promise((resolve) => {
    const child = spawn(process.execPath, [nextCliPath, ...nextBuildArgs], {
      cwd: packageRoot,
      env: {
        ...process.env,
        NEXT_DIST_DIR: tempDistDirName,
      },
      stdio: "inherit",
    });

    child.on("close", (code) => {
      resolve(code ?? 1);
    });
  });

  return exitCode;
}

let exitCode = 1;
let restored = false;

async function restoreGeneratedInputs() {
  if (restored) return;
  restored = true;

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

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.once(signal, async () => {
    await restoreGeneratedInputs();
    process.kill(process.pid, signal);
  });
}

try {
  exitCode = await runNextBuild();

  if (exitCode === 0) {
    rmRecursive(finalDistDir);
    await rename(tempDistDir, finalDistDir);
  } else {
    rmRecursive(tempDistDir);
  }
} finally {
  await restoreGeneratedInputs();
}

process.exit(exitCode);
