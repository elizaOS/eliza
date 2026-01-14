/**
 * Main run CLI tests converted from test_run.py
 */

import { execFileSync, spawnSync } from "node:child_process";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

describe("Run CLI", () => {
  const cwd = path.join(__dirname, "..");
  const node = process.execPath;
  const cliPath = path.join(cwd, "dist", "run", "cli.js");

  function runOk(args: string[], input?: string): string {
    return execFileSync(node, [cliPath, ...args], {
      encoding: "utf-8",
      cwd,
      input,
      timeout: 5000,
    });
  }

  function runFail(
    args: string[],
    input?: string,
  ): { stdout: string; stderr: string; status: number } {
    const res = spawnSync(node, [cliPath, ...args], {
      encoding: "utf-8",
      cwd,
      input,
      timeout: 5000,
    });
    return {
      stdout: res.stdout ?? "",
      stderr: res.stderr ?? "",
      status: res.status ?? -1,
    };
  }

  let mainHelp = "";
  let runHelp = "";
  let runBatchHelp = "";
  let runReplayHelp = "";
  let version = "";

  beforeAll(() => {
    // Cache expensive CLI calls to keep this suite fast and stable.
    mainHelp = runOk(["--help"]);
    runHelp = runOk(["run", "--help"]);
    runBatchHelp = runOk(["run-batch", "--help"]);
    runReplayHelp = runOk(["run-replay", "--help"]);
    version = runOk(["--version"]);
  });

  describe("Main CLI behavior", () => {
    it("should show error when no arguments provided", () => {
      const res = runFail([]);

      // Should exit with error code
      expect(res.status).toBeGreaterThan(0);
      expect(res.status).toBeLessThanOrEqual(2);

      // Should show available commands
      const combinedOutput = res.stdout + res.stderr;
      expect(combinedOutput).toContain("run-batch");
      expect(combinedOutput).toContain("run-replay");
      expect(combinedOutput).toContain("run");
    });

    it("should show help with --help flag", () => {
      // Should show all available commands
      expect(mainHelp).toContain("run-batch");
      expect(mainHelp).toContain("run-replay");
      expect(mainHelp).toContain("run");

      // Should show descriptions
      expect(mainHelp.toLowerCase()).toContain("batch");
      expect(mainHelp.toLowerCase()).toContain("replay");
    });

    it("should show version with --version flag", () => {
      // Should show version number
      expect(version).toMatch(/\d+\.\d+\.\d+/);
    });
  });

  describe("Subcommand help", () => {
    it("should show help for run subcommand", () => {
      // Should show run-specific options
      expect(runHelp).toContain("--config");
      expect(runHelp).toContain("--agent");
      expect(runHelp).toContain("--output_dir");
      expect(runHelp).toContain("--problem_statement");
    });

    it("should show help for run-batch subcommand", () => {
      // Should show batch-specific options
      expect(runBatchHelp).toContain("--instances");
      expect(runBatchHelp).toContain("--num_workers");
      expect(runBatchHelp).toContain("--output_dir");
    });

    it("should show help for run-replay subcommand", () => {
      // Should show replay-specific options
      expect(runReplayHelp).toContain("--traj_path");
      expect(runReplayHelp).toContain("--forward_only");
      expect(runReplayHelp).toContain("--n_forward");
    });
  });

  describe("Command aliases", () => {
    it("should support sweagent command", () => {
      const sweagentPath = path.join(__dirname, "..", "bin", "sweagent");
      const output = execFileSync(sweagentPath, ["--help"], {
        encoding: "utf-8",
        cwd,
        timeout: 5000,
      });

      expect(output).toContain("run-batch");
      expect(output).toContain("run-replay");
    });
  });

  describe("Error handling", () => {
    it("should show error for unknown subcommand", () => {
      const res = runFail(["unknown-command"]);
      expect(res.stdout + res.stderr).toContain("unknown");
    });

    it("should show error for invalid arguments", () => {
      const res = runFail(["run", "--invalid-arg", "value"]);
      expect((res.stdout + res.stderr).toLowerCase()).toContain("invalid");
    });

    it("should validate required arguments", () => {
      const res = runFail(["run-replay"]);
      expect(res.stdout + res.stderr).toContain("traj_path");
    });
  });

  describe("Configuration loading", () => {
    it("should support --config flag", () => {
      expect(runHelp).toContain("--config");
      expect(runHelp.toLowerCase()).toContain("configuration file");
    });

    it("should support environment variables", () => {
      // Test that environment variables are documented
      // Should mention environment variables somewhere
      expect(runHelp.toLowerCase()).toMatch(/env|environment/);
    });
  });

  describe("Output formats", () => {
    it("should support JSON output", () => {
      // Check if JSON output is mentioned
      expect(runHelp.toLowerCase()).toMatch(/json|format/);
    });

    it("should support verbose mode", () => {
      // Should have verbose/debug options
      expect(runHelp.toLowerCase()).toMatch(/verbose|debug|log/);
    });
  });

  describe("Batch processing", () => {
    it("should document batch options", () => {
      // Should document key batch options
      expect(runBatchHelp).toContain("num_workers");
      expect(runBatchHelp.toLowerCase()).toContain("parallel");
    });

    it("should document instance filtering", () => {
      // Should have filtering options
      expect(runBatchHelp.toLowerCase()).toMatch(/filter|slice|shuffle/);
    });
  });

  describe("Integration tests", () => {
    it("should handle piped input", () => {
      const output = runOk(["run", "--help"], '{"test": true}\n');
      expect(output).toContain("Run swe-agent on a single problem statement");
    });
  });

  describe("Python compatibility", () => {
    it("should have similar command structure to Python version", () => {
      // The TypeScript version should maintain compatibility with Python version
      // Should have the same main commands as Python version
      expect(mainHelp).toContain("run");
      expect(mainHelp).toContain("run-batch");
      expect(mainHelp).toContain("run-replay");

      // Should use similar terminology
      expect(mainHelp.toLowerCase()).toContain("agent");
      expect(mainHelp.toLowerCase()).toContain("instance");
    });
  });

  describe("Documentation", () => {
    it("should provide examples in help", () => {
      // Good CLI tools provide examples
      const hasExamples =
        runHelp.toLowerCase().includes("example") ||
        runHelp.toLowerCase().includes("usage");

      expect(hasExamples).toBe(true);
    });

    it("should document config file format", () => {
      // Should mention YAML or config format
      const hasConfigFormat =
        runHelp.toLowerCase().includes("yaml") ||
        runHelp.toLowerCase().includes("config");

      expect(hasConfigFormat).toBe(true);
    });
  });
});
