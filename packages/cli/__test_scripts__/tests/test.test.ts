import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { execSync } from "child_process";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

describe("ElizaOS Test Commands", () => {
  let testTmpDir: string;
  let elizaosCmd: string;

  beforeEach(async () => {
    // Setup test environment for each test
    testTmpDir = await mkdtemp(join(tmpdir(), "eliza-test-test-"));
    
    // Setup CLI command
    const scriptDir = join(__dirname, "..");
    elizaosCmd = `bun run ${join(scriptDir, "../dist/index.js")}`;
    
    // Change to test directory
    process.chdir(testTmpDir);
  });

  afterEach(async () => {
    if (testTmpDir) {
      try {
        await rm(testTmpDir, { recursive: true });
      } catch (e) {
        // Ignore cleanup errors
      }
    }
  });

  test("test --help shows usage", async () => {
    const result = execSync(`${elizaosCmd} test --help`, { encoding: "utf8" });
    expect(result).toContain("Usage: elizaos test");
  });

  test("test command accepts -n option with quotes", async () => {
    const result = execSync(`${elizaosCmd} test -n "filter-name" --help`, { encoding: "utf8" });
    expect(result).toContain("Filter tests by name");
  });

  test("test command accepts -n option without quotes", async () => {
    const result = execSync(`${elizaosCmd} test -n filter-name --help`, { encoding: "utf8" });
    expect(result).toContain("Filter tests by name");
  });

  test("test command accepts --name option", async () => {
    const result = execSync(`${elizaosCmd} test --name filter-name --help`, { encoding: "utf8" });
    expect(result).toContain("Filter tests by name");
  });

  test("test component command accepts -n option", async () => {
    const result = execSync(`${elizaosCmd} test component -n filter-name --help`, { encoding: "utf8" });
    expect(result).toContain("component");
  });

  test("test e2e command accepts -n option", async () => {
    const result = execSync(`${elizaosCmd} test e2e -n filter-name --help`, { encoding: "utf8" });
    expect(result).toContain("e2e");
  });

  test("test command accepts --skip-build option", async () => {
    const result = execSync(`${elizaosCmd} test --skip-build --help`, { encoding: "utf8" });
    expect(result).toContain("Skip building before running tests");
  });

  test("test command accepts combination of options", async () => {
    const result = execSync(`${elizaosCmd} test -n filter-name --skip-build --help`, { encoding: "utf8" });
    expect(result).toContain("Filter tests by name");
    expect(result).toContain("Skip building before running tests");
  });

  test("test command handles basic name format", async () => {
    const result = execSync(`${elizaosCmd} test -n basic --help`, { encoding: "utf8" });
    expect(result).toContain("Usage: elizaos test");
  });

  test("test command handles .test name format", async () => {
    const result = execSync(`${elizaosCmd} test -n basic.test --help`, { encoding: "utf8" });
    expect(result).toContain("Usage: elizaos test");
  });

  test("test command handles .test.ts name format", async () => {
    const result = execSync(`${elizaosCmd} test -n basic.test.ts --help`, { encoding: "utf8" });
    expect(result).toContain("Usage: elizaos test");
  });
});