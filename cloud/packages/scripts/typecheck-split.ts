/**
 * Split Type-Check Script
 *
 * WHY THIS EXISTS:
 * Running `tsc --noEmit` on the full project can use 15-20GB of RAM because
 * TypeScript loads the entire dependency graph into memory. This script splits
 * the type-check into smaller chunks by creating temporary tsconfig files for
 * each major directory.
 *
 * HOW IT WORKS:
 * 1. Creates a temporary tsconfig for each db/lib directory
 * 2. Runs tsc on each directory in a small worker pool
 * 3. Each run starts fresh, keeping memory usage lower than one monolithic tsc
 * 4. Reports errors from all directories at the end
 *
 * Usage: bun run packages/scripts/typecheck-split.ts
 */

import { spawn } from "node:child_process";
import { mkdir, readdir, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const SKIP_DIRECTORY_NAMES = new Set(["node_modules", "dist", "build", ".turbo"]);

interface CheckResult {
  directory: string;
  success: boolean;
  output: string;
  duration: number;
}

interface TscRunResult {
  success: boolean;
  output: string;
  signal: NodeJS.Signals | null;
}

/**
 * Split a directory into subdirectories for smaller type-check chunks.
 * Returns the subdirectories as an array, or [dir] if no subdirectories found.
 */
async function splitIntoSubdirectories(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    const subdirs = entries
      .filter((entry) => entry.isDirectory())
      .filter((entry) => !SKIP_DIRECTORY_NAMES.has(entry.name))
      .map((entry) => join(dir, entry.name))
      .sort();

    return subdirs.length > 0 ? subdirs : [dir];
  } catch {
    return [dir];
  }
}

async function getDirectoriesToCheck(): Promise<string[]> {
  const libSubdirs = await splitIntoSubdirectories("packages/lib");

  return ["packages/db", ...libSubdirs];
}

async function createTempTsconfig(directory: string): Promise<string> {
  const safeDirectoryName = directory.replace(/[\\/]/g, ".");
  const workspaceRoot = process.cwd();
  const tempDir = join(workspaceRoot, "node_modules", ".cache", "typecheck-split");
  await mkdir(tempDir, { recursive: true });
  const tempPath = join(
    tempDir,
    `eliza-cloud.tsconfig.${safeDirectoryName}.${process.pid}.${Date.now()}.json`,
  );

  // Use `extends` so the parent tsconfig's `paths` resolve relative to its own
  // location (the workspace root). TS 6.0 deprecates the `baseUrl` option, so
  // we cannot inject one to redirect path resolution here.
  const tempConfig = {
    extends: resolve(workspaceRoot, "tsconfig.json"),
    compilerOptions: {
      incremental: false,
      skipLibCheck: true,
      skipDefaultLibCheck: true,
    },
    include: [
      resolve(workspaceRoot, "next-env.d.ts"),
      resolve(workspaceRoot, "types/**/*.d.ts"),
      resolve(workspaceRoot, "packages/types/**/*.d.ts"),
      resolve(workspaceRoot, `${directory}/**/*.ts`),
      resolve(workspaceRoot, `${directory}/**/*.tsx`),
    ],
    // Keep the same excludes (include __tests__ so bun:test files are not type-checked with node types)
    exclude: [
      resolve(workspaceRoot, "node_modules"),
      resolve(workspaceRoot, "**/node_modules/**"),
      resolve(workspaceRoot, "ignore"),
      resolve(workspaceRoot, "e2e"),
      resolve(workspaceRoot, "scripts"),
      resolve(workspaceRoot, "tests"),
      resolve(workspaceRoot, "**/__tests__/**"),
      resolve(workspaceRoot, "**/*.test.ts"),
      resolve(workspaceRoot, "**/*.test.tsx"),
      resolve(workspaceRoot, "**/*.stories.ts"),
      resolve(workspaceRoot, "**/*.stories.tsx"),
      resolve(workspaceRoot, ".next"),
      resolve(workspaceRoot, "out"),
      resolve(workspaceRoot, "build"),
      resolve(workspaceRoot, "dist"),
      resolve(workspaceRoot, ".turbo"),
      resolve(workspaceRoot, "coverage"),
      resolve(workspaceRoot, ".next/types"),
      resolve(workspaceRoot, ".next/dev/types"),
    ],
  };

  await writeFile(tempPath, JSON.stringify(tempConfig, null, 2));
  return tempPath;
}

async function runTsc(tscPath: string, tempConfigPath: string): Promise<TscRunResult> {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [tscPath, "--noEmit", "--project", tempConfigPath], {
      env: { ...process.env, NODE_OPTIONS: "--max-old-space-size=2048" },
    });
    let output = "";

    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    child.on("error", (error) => {
      resolveRun({ success: false, output: error.message, signal: null });
    });
    child.on("close", (code, signal) => {
      resolveRun({ success: code === 0, output, signal });
    });
  });
}

async function checkDirectory(directory: string): Promise<CheckResult> {
  const start = Date.now();
  let tempConfigPath: string | null = null;

  try {
    console.log(`\n📁 Checking ${directory}/...`);

    tempConfigPath = await createTempTsconfig(directory);
    const workspaceRoot = process.cwd();
    const tscPath = resolve(workspaceRoot, "node_modules", "typescript", "lib", "tsc.js");

    let tscRun = await runTsc(tscPath, tempConfigPath);
    if (!tscRun.success && tscRun.signal === "SIGKILL" && !tscRun.output.trim()) {
      tscRun = await runTsc(tscPath, tempConfigPath);
    }

    if (!tscRun.success) {
      throw new Error(
        tscRun.output ||
          `tsc exited without diagnostics${tscRun.signal ? ` after ${tscRun.signal}` : ""}`,
      );
    }

    const output = tscRun.output;
    const duration = Date.now() - start;

    console.log(`   ✓ ${directory}/ passed (${(duration / 1000).toFixed(1)}s)`);

    return { directory, success: true, output, duration };
  } catch (error) {
    const duration = Date.now() - start;
    const output =
      error instanceof Error
        ? (error as Error & { stdout?: string; stderr?: string }).stdout ||
          (error as Error & { stdout?: string; stderr?: string }).stderr ||
          error.message
        : String(error);

    console.log(`   ✗ ${directory}/ has errors (${(duration / 1000).toFixed(1)}s)`);

    return { directory, success: false, output, duration };
  } finally {
    if (tempConfigPath) {
      await unlink(tempConfigPath).catch(() => {});
    }
  }
}

async function main() {
  console.log("🔍 Split Type-Check");
  console.log("==================");
  console.log("Checking directories separately to reduce memory usage.\n");

  const directories = await getDirectoriesToCheck();
  console.log(`Found ${directories.length} directories to check\n`);
  const requestedConcurrency = Number.parseInt(process.env.CHECK_TYPES_CONCURRENCY ?? "2", 10);
  const concurrency = Number.isFinite(requestedConcurrency) ? Math.max(1, requestedConcurrency) : 2;
  const workerCount = Math.min(concurrency, directories.length);
  console.log(`Using ${workerCount} type-check worker(s)\n`);

  const results: CheckResult[] = [];
  const totalStart = Date.now();
  let nextDirectoryIndex = 0;

  async function runWorker() {
    while (nextDirectoryIndex < directories.length) {
      const dir = directories[nextDirectoryIndex];
      nextDirectoryIndex += 1;

      if (global.gc) {
        global.gc();
      }

      const result = await checkDirectory(dir);
      results.push(result);
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));

  const totalDuration = Date.now() - totalStart;

  console.log("\n==================");
  console.log("📊 Summary");
  console.log("==================\n");

  const failed = results.filter((result) => !result.success);
  const passed = results.filter((result) => result.success);

  console.log(`Total time: ${(totalDuration / 1000).toFixed(1)}s`);
  console.log(`Passed: ${passed.length}/${results.length}`);

  if (failed.length > 0) {
    console.log(`\n❌ Errors found in ${failed.length} directory(s):\n`);

    for (const result of failed) {
      console.log(`\n--- ${result.directory}/ ---\n`);
      const lines = result.output.split("\n").filter((line) => {
        return (
          line.trim() &&
          !line.includes("Resolving dependencies") &&
          !line.includes("Saved lockfile")
        );
      });
      console.log(lines.join("\n"));
    }

    process.exit(1);
  }

  console.log("\n✅ All type checks passed!");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
