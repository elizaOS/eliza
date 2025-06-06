import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { execSync } from "child_process";
import { mkdtemp, rm, writeFile, mkdir, readFile, access } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { existsSync } from "fs";

describe("ElizaOS Setup Monorepo Commands", () => {
  let testTmpDir: string;
  let elizaosCmd: string;
  let originalCwd: string;
  let originalPath: string;

  beforeEach(async () => {
    // Store original working directory and PATH
    originalCwd = process.cwd();
    originalPath = process.env.PATH || "";
    
    // Create temporary directory
    testTmpDir = await mkdtemp(join(tmpdir(), "eliza-test-monorepo-"));
    process.chdir(testTmpDir);
    
    // Setup CLI command
    const scriptDir = join(__dirname, "..");
    elizaosCmd = `bun run ${join(scriptDir, "../dist/index.js")}`;

    // ---------------------------------------------------------------------------
    // Fake git implementation that records its argv and creates a dummy repo.
    // ---------------------------------------------------------------------------
    const binDir = join(testTmpDir, "bin");
    await mkdir(binDir, { recursive: true });
    
    const gitMockScript = `#!/usr/bin/env bash
printf '%q ' "$@" > "${testTmpDir}/git_args.txt"
if [[ "$1" == clone ]]; then
  dest="\${@: -1}"
  mkdir -p "$dest/packages" "$dest/.git"
  echo '{}' > "$dest/package.json"
  echo "Cloned successfully to $dest"
  exit 0
else
  echo "git $*"
  exit 0
fi`;
    
    await writeFile(join(binDir, "git"), gitMockScript);
    execSync(`chmod +x ${join(binDir, "git")}`);
    process.env.PATH = `${binDir}:${originalPath}`;
  });

  afterEach(async () => {
    // Restore original working directory and PATH
    process.chdir(originalCwd);
    process.env.PATH = originalPath;
    
    if (testTmpDir && testTmpDir.includes("eliza-test-monorepo-")) {
      try {
        await rm(testTmpDir, { recursive: true });
      } catch (e) {
        // Ignore cleanup errors
      }
    }
  });

  // --help
  test("setup-monorepo --help shows usage", () => {
    const result = execSync(`${elizaosCmd} setup-monorepo --help`, { encoding: "utf8" });
    expect(result).toContain("Usage: elizaos setup-monorepo");
    expect(result).toContain("-b");
    expect(result).toContain("--branch");
    expect(result).toContain("-d");
    expect(result).toContain("--dir");
  });

  // Test help and basic flag recognition (these work reliably)
  test("setup-monorepo command works with help", () => {
    const result = execSync(`${elizaosCmd} setup-monorepo --help`, { encoding: "utf8" });
    expect(result).toContain("setup-monorepo");
  });

  test("setup-monorepo shows branch option", () => {
    const result = execSync(`${elizaosCmd} setup-monorepo --help`, { encoding: "utf8" });
    expect(result).toContain("--branch");
  });

  test("setup-monorepo shows directory option", () => {
    const result = execSync(`${elizaosCmd} setup-monorepo --help`, { encoding: "utf8" });
    expect(result).toContain("--dir");
  });

  // Directory must be empty
  test("setup-monorepo fails when directory is not empty", async () => {
    await mkdir("not-empty-dir");
    await writeFile(join("not-empty-dir", "placeholder"), "");
    
    try {
      execSync(`${elizaosCmd} setup-monorepo --dir not-empty-dir`, { 
        stdio: "pipe",
        timeout: 10000
      });
      expect(false).toBe(true); // Should not reach here
    } catch (e: any) {
      expect(e.status).not.toBe(0);
      const output = e.stdout?.toString() || e.stderr?.toString() || "";
      expect(output).toMatch(/not empty/);
    }
  });
});