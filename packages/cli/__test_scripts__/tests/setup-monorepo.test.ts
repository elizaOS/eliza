import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { execSync } from "child_process";
import { mkdtemp, rm, writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

describe("ElizaOS Setup Monorepo Commands", () => {
  let testTmpDir: string;
  let elizaosCmd: string;
  let originalCwd: string;

  beforeEach(async () => {
    // Store original working directory
    originalCwd = process.cwd();
    
    // Create temporary directory
    testTmpDir = await mkdtemp(join(tmpdir(), "eliza-test-monorepo-"));
    process.chdir(testTmpDir);
    
    // Setup CLI command
    const scriptDir = join(__dirname, "..");
    elizaosCmd = `bun run ${join(scriptDir, "../dist/index.js")}`;
  });

  afterEach(async () => {
    // Restore original working directory
    process.chdir(originalCwd);
    
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

  test("setup-monorepo uses default branch and directory", () => {
    // This would try to clone, so we just test that it recognizes the command
    // without actually performing the network operation
    const result = execSync(`${elizaosCmd} setup-monorepo --help`, { encoding: "utf8" });
    expect(result).toContain("Branch to install");
    expect(result).toContain("develop"); // default branch
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