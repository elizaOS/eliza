import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { execSync } from "child_process";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { existsSync } from "fs";

describe("ElizaOS Env Commands", () => {
  let testTmpDir: string;
  let elizaosCmd: string;

  beforeEach(async () => {
    // Setup test environment for each test
    testTmpDir = await mkdtemp(join(tmpdir(), "eliza-test-env-"));
    
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

  test("env --help shows usage", async () => {
    const result = execSync(`${elizaosCmd} env --help`, { encoding: "utf8" });
    expect(result).toContain("Usage: elizaos env");
  });

  test("env list shows environment variables", async () => {
    // First call: no local .env file present
    let result = execSync(`${elizaosCmd} env list`, { encoding: "utf8" });
    
    const expectedSections = ["System Information", "Local Environment Variables"];
    for (const section of expectedSections) {
      expect(result).toContain(section);
    }
    
    expect(result).toMatch(/(No local \.env file found|Missing \.env file)/);

    // Create a local .env file and try again
    await writeFile(".env", "TEST_VAR=test_value");
    
    result = execSync(`${elizaosCmd} env list`, { encoding: "utf8" });
    expect(result).toContain("TEST_VAR");
    expect(result).toContain("test_value");
  });

  test("env list --local shows only local environment", async () => {
    await writeFile(".env", "LOCAL_TEST=local_value");
    
    const result = execSync(`${elizaosCmd} env list --local`, { encoding: "utf8" });
    
    expect(result).toContain("LOCAL_TEST");
    expect(result).toContain("local_value");
    expect(result).not.toContain("System Information");
  });

  test("env edit-local creates local .env if missing", async () => {
    expect(existsSync(".env")).toBe(false);
    
    // Use printf to simulate user input
    const result = execSync(`printf "y\\n" | ${elizaosCmd} env edit-local`, { 
      encoding: "utf8",
      shell: "/bin/bash"
    });
    
    expect(existsSync(".env")).toBe(true);
  });

  test("env reset shows all necessary options", async () => {
    await writeFile(".env", "DUMMY=value");
    
    const result = execSync(`${elizaosCmd} env reset --yes`, { encoding: "utf8" });
    
    expect(result).toContain("Reset Summary");
    expect(result).toContain("Local environment variables");
    expect(result).toContain("Environment reset complete");
  });
});