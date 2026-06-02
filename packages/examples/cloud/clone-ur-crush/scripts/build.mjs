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

await rm(tempDistDir, {
  force: true,
  maxRetries: 5,
  recursive: true,
  retryDelay: 100,
});

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
  if (!include.includes(tempTypesGlob)) {
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
    const child = spawn(process.execPath, [nextCliPath, "build"], {
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

try {
  exitCode = await runNextBuild();

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
