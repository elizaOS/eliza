/**
 * Unit tests for testing-coverage-matrix.mjs CLI parameter validation,
 * matrix generation, and execution modes.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  generateMatrixData,
  parseArgs,
  runCli,
} from "./testing-coverage-matrix.mjs";

describe("testing coverage matrix script", () => {
  describe("parseArgs", () => {
    it("parses empty arguments to defaults", () => {
      const parsed = parseArgs([]);
      assert.deepEqual(parsed, { check: false, output: "", help: false });
    });

    it("parses valid flags correctly", () => {
      assert.equal(parseArgs(["--check"]).check, true);
      assert.equal(parseArgs(["--help"]).help, true);
      assert.equal(parseArgs(["-h"]).help, true);
      assert.equal(parseArgs(["--output", "custom.md"]).output, "custom.md");
      assert.equal(parseArgs(["--output=custom.md"]).output, "custom.md");
    });

    it("rejects unknown options", () => {
      assert.throws(
        () => parseArgs(["--invalid-option"]),
        /Unknown option or argument: --invalid-option/,
      );
    });

    it("rejects --output without a value", () => {
      assert.throws(
        () => parseArgs(["--output"]),
        /Option '--output' requires a non-empty file path argument./,
      );
      assert.throws(
        () => parseArgs(["--output", "--check"]),
        /Option '--output' requires a non-empty file path argument./,
      );
      assert.throws(
        () => parseArgs(["--output="]),
        /Option '--output' requires a non-empty file path argument./,
      );
    });
  });

  describe("generateMatrixData", () => {
    it("builds correct matrix summary and table from mocked repo structure", () => {
      const mockFiles = [
        "package.json",
        "packages/pkg-a/package.json",
        "packages/pkg-a/src/index.test.ts",
        "packages/pkg-b/package.json",
      ];

      const mockJson = {
        "package.json": { name: "root", workspaces: ["packages/*"] },
        "packages/pkg-a/package.json": {
          name: "@elizaos/pkg-a",
          scripts: { test: "vitest" },
        },
        "packages/pkg-b/package.json": {
          name: "@elizaos/pkg-b",
          scripts: {},
        },
      };

      const mockTexts = {
        "packages/pkg-a/src/index.test.ts": `
          describe.skip("suite", () => {
            it("test 1", () => {});
            it.skip("test 2", () => {});
            test.skip("test 3", () => {});
            xit("test 4", () => {});
          });
        `,
      };

      const result = generateMatrixData({
        files: mockFiles,
        readJsonFn: (rel) => mockJson[rel] ?? null,
        readFileTextFn: (file) => mockTexts[file] ?? null,
      });

      assert.equal(result.totals.withTests, 1);
      assert.equal(result.totals.inCi, 1);
      assert.equal(result.totals.testFiles, 1);
      assert.equal(result.totals.skips, 4);
      assert.equal(result.totals.zeroTestWithScript, 0);

      assert.ok(result.content.includes("# Testing coverage matrix"));
      assert.ok(result.content.includes("| @elizaos/pkg-a | `packages/pkg-a` | 1 | 4 | yes | yes |"));
    });

    it("respects workspace negations in root package.json", () => {
      const mockFiles = [
        "package.json",
        "packages/pkg-a/package.json",
        "packages/ignored/package.json",
      ];

      const mockJson = {
        "package.json": { name: "root", workspaces: ["packages/*", "!packages/ignored"] },
        "packages/pkg-a/package.json": {
          name: "@elizaos/pkg-a",
          scripts: { test: "vitest" },
        },
        "packages/ignored/package.json": {
          name: "@elizaos/ignored",
          scripts: { test: "vitest" },
        },
      };

      const result = generateMatrixData({
        files: mockFiles,
        readJsonFn: (rel) => mockJson[rel] ?? null,
        readFileTextFn: () => null,
      });

      assert.equal(result.totals.inCi, 1);
      assert.ok(result.content.includes("| @elizaos/ignored | `packages/ignored` | 0 | 0 | yes | no |"));
    });
  });

  describe("runCli", () => {
    it("returns exit code 0 and prints help when --help is passed", () => {
      let stdout = "";
      let stderr = "";
      const code = runCli(["--help"], {
        stdout: { write: (msg) => (stdout += msg) },
        stderr: { write: (msg) => (stderr += msg) },
      });

      assert.equal(code, 0);
      assert.ok(stdout.includes("Usage: node scripts/testing-coverage-matrix.mjs"));
      assert.equal(stderr, "");
    });

    it("returns exit code 2 and prints error on invalid options", () => {
      let stdout = "";
      let stderr = "";
      const code = runCli(["--bogus"], {
        stdout: { write: (msg) => (stdout += msg) },
        stderr: { write: (msg) => (stderr += msg) },
      });

      assert.equal(code, 2);
      assert.ok(stderr.includes("[testing-coverage-matrix] Error: Unknown option or argument: --bogus"));
      assert.equal(stdout, "");
    });

    it("writes matrix output file and creates nested directory if needed", () => {
      const tmpDir = mkdtempSync(path.join(tmpdir(), "matrix-test-"));
      const outFile = path.join(tmpDir, "nested", "matrix.md");

      let stdout = "";
      let stderr = "";
      try {
        const code = runCli(["--output", outFile], {
          stdout: { write: (msg) => (stdout += msg) },
          stderr: { write: (msg) => (stderr += msg) },
        });

        assert.equal(code, 0);
        assert.ok(existsSync(outFile));
        const content = readFileSync(outFile, "utf8");
        assert.ok(content.includes("# Testing coverage matrix"));
        assert.ok(stdout.includes("Wrote "));
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("validates --check mode when file is stale vs up to date", () => {
      const tmpDir = mkdtempSync(path.join(tmpdir(), "matrix-check-"));
      const outFile = path.join(tmpDir, "matrix.md");

      let stdout = "";
      let stderr = "";
      try {
        // Run once to create current matrix
        runCli(["--output", outFile], {
          stdout: { write: () => {} },
          stderr: { write: () => {} },
        });

        // Check against matching file -> pass (code 0)
        stdout = "";
        stderr = "";
        let code = runCli(["--check", "--output", outFile], {
          stdout: { write: (msg) => (stdout += msg) },
          stderr: { write: (msg) => (stderr += msg) },
        });
        assert.equal(code, 0);
        assert.ok(stdout.includes("is up to date."));

        // Modify file to make it stale -> fail (code 1)
        writeFileSync(outFile, "# Stale Content\n");
        stdout = "";
        stderr = "";
        code = runCli(["--check", "--output", outFile], {
          stdout: { write: (msg) => (stdout += msg) },
          stderr: { write: (msg) => (stderr += msg) },
        });
        assert.equal(code, 1);
        assert.ok(stderr.includes("is stale. Run `node scripts/testing-coverage-matrix.mjs`."));
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });
});
