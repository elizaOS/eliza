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
 * 1. Creates a temporary tsconfig for each directory (app, components, lib, db)
 * 2. Runs tsc on each directory separately in sequence
 * 3. Each run starts fresh, keeping memory usage lower
 * 4. Reports errors from all directories at the end
 *
 * Usage: bun run scripts/check-types-split.ts
 */

import { exec } from "node:child_process";
import { writeFile, unlink, readFile } from "node:fs/promises";
import { promisify } from "node:util";

const execAsync = promisify(exec);

interface CheckResult {
  directory: string;
  success: boolean;
  output: string;
  duration: number;
}

const DIRECTORIES = ["db", "lib", "components", "app"];

async function createTempTsconfig(
  directory: string,
  baseTsconfig: object
): Promise<string> {
  const tempPath = `tsconfig.${directory}.temp.json`;

  const tempConfig = {
    ...baseTsconfig,
    compilerOptions: {
      ...(baseTsconfig as { compilerOptions: object }).compilerOptions,
      // Disable incremental for temp configs to avoid conflicts
      incremental: false,
      tsBuildInfoFile: undefined,
    },
    include: [
      "next-env.d.ts",
      "types/**/*.d.ts",
      `${directory}/**/*.ts`,
      `${directory}/**/*.tsx`,
    ],
    // Keep the same excludes
    exclude: [
      "node_modules",
      "ignore",
      "e2e",
      "scripts",
      "tests",
      ".next",
      "out",
      "build",
      "dist",
      ".turbo",
      "coverage",
    ],
  };

  await writeFile(tempPath, JSON.stringify(tempConfig, null, 2));
  return tempPath;
}

async function checkDirectory(
  directory: string,
  baseTsconfig: object
): Promise<CheckResult> {
  const start = Date.now();
  let tempConfigPath: string | null = null;

  try {
    console.log(`\n📁 Checking ${directory}/...`);

    tempConfigPath = await createTempTsconfig(directory, baseTsconfig);

    const { stdout, stderr } = await execAsync(
      `bunx tsc --noEmit --project ${tempConfigPath} 2>&1`,
      {
        maxBuffer: 10 * 1024 * 1024, // 10MB buffer for large output
        env: { ...process.env, NODE_OPTIONS: "--max-old-space-size=4096" },
      }
    );

    const output = stdout + stderr;
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
    // Clean up temp config
    if (tempConfigPath) {
      await unlink(tempConfigPath).catch(() => {});
    }
  }
}

async function main() {
  console.log("🔍 Split Type-Check");
  console.log("==================");
  console.log("Checking directories separately to reduce memory usage.\n");

  // Read base tsconfig
  const baseTsconfigContent = await readFile("tsconfig.json", "utf-8");
  const baseTsconfig = JSON.parse(baseTsconfigContent);

  const results: CheckResult[] = [];
  const totalStart = Date.now();

  // Check each directory sequentially
  for (const dir of DIRECTORIES) {
    // Force garbage collection between runs if available
    if (global.gc) {
      global.gc();
    }

    const result = await checkDirectory(dir, baseTsconfig);
    results.push(result);
  }

  const totalDuration = Date.now() - totalStart;

  // Summary
  console.log("\n==================");
  console.log("📊 Summary");
  console.log("==================\n");

  const failed = results.filter((r) => !r.success);
  const passed = results.filter((r) => r.success);

  console.log(`Total time: ${(totalDuration / 1000).toFixed(1)}s`);
  console.log(`Passed: ${passed.length}/${results.length}`);

  if (failed.length > 0) {
    console.log(`\n❌ Errors found in ${failed.length} directory(s):\n`);

    for (const result of failed) {
      console.log(`\n--- ${result.directory}/ ---\n`);
      // Filter out noise and show actual errors
      const lines = result.output.split("\n").filter((line) => {
        // Skip empty lines and some noise
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
