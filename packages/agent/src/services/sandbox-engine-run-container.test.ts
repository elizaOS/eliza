/**
 * Process-boundary coverage for Apple Container startup stdio. The engine runs
 * in an outer Node subprocess so this test observes exactly what its inherited
 * stdout/stderr descriptors make visible to the caller.
 */

import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

const SERVICE_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(SERVICE_DIRECTORY, "../../../..");
const HARNESS_PATH = join(
  SERVICE_DIRECTORY,
  "sandbox-engine-run-container.harness.ts",
);
const STDOUT_BYTES = 300_000;
const STDOUT_SENTINEL = "<stdout-complete>\n";
const RESOLVED_MARKER = "HARNESS_RESOLVED:eliza-sandbox-stdout\n";

let binDirectory: string | undefined;
let previousBaseline: string | undefined;

function installContainerStub(body: string): void {
  binDirectory = mkdtempSync(join(tmpdir(), "eliza-container-stub-"));
  const stub = join(binDirectory, "container");
  writeFileSync(stub, `#!${process.execPath}\n${body}`);
  chmodSync(stub, 0o755);
}

function runHarness(mode: "stdout" | "immediate-exit"): Promise<{
  code: number | null;
  stdout: Buffer;
  stderr: Buffer;
}> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(
      process.execPath,
      ["--conditions=eliza-source", "--import", "tsx", HARNESS_PATH, mode],
      {
        cwd: REPOSITORY_ROOT,
        env: {
          ...process.env,
          ELIZA_HOST_EXECUTION_BASELINE_PATH: binDirectory,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("sandbox-engine subprocess harness timed out"));
    }, 45_000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      resolveResult({
        code,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
      });
    });
  });
}

describe.skipIf(process.platform === "win32")(
  "Apple Container inherited startup stdio",
  () => {
    beforeAll(() => {
      previousBaseline = process.env.ELIZA_HOST_EXECUTION_BASELINE_PATH;
    });

    afterEach(() => {
      if (binDirectory) {
        rmSync(binDirectory, { recursive: true, force: true });
        binDirectory = undefined;
      }
    });

    afterAll(() => {
      // Other files can share this vitest worker, so preserve the environment
      // even though each outer harness receives its baseline through spawn.
      if (previousBaseline === undefined) {
        delete process.env.ELIZA_HOST_EXECUTION_BASELINE_PATH;
      } else {
        process.env.ELIZA_HOST_EXECUTION_BASELINE_PATH = previousBaseline;
      }
    });

    it("forwards every stdout byte without a child pipe or truncation", async () => {
      installContainerStub(
        [
          `process.stdout.write("x".repeat(${STDOUT_BYTES}));`,
          `process.stdout.write(${JSON.stringify(STDOUT_SENTINEL)});`,
          "setTimeout(() => process.exit(0), 3000);",
        ].join("\n"),
      );

      const result = await runHarness("stdout");

      expect(result.code).toBe(0);
      expect(result.stderr).toEqual(Buffer.alloc(0));
      const resolvedMarker = Buffer.from(RESOLVED_MARKER);
      const resolvedMarkerOffset = result.stdout.indexOf(resolvedMarker);
      expect(resolvedMarkerOffset).toBeGreaterThanOrEqual(0);
      // The harness and detached child inherit the same pipe, so scheduling may
      // place this harness marker before, within, or after the child payload.
      const containerStdout = Buffer.concat([
        result.stdout.subarray(0, resolvedMarkerOffset),
        result.stdout.subarray(resolvedMarkerOffset + resolvedMarker.length),
      ]);
      expect(containerStdout).toEqual(
        Buffer.from(`${"x".repeat(STDOUT_BYTES)}${STDOUT_SENTINEL}`),
      );
      expect(result.stdout.length).toBe(
        STDOUT_BYTES +
          Buffer.byteLength(STDOUT_SENTINEL) +
          Buffer.byteLength(RESOLVED_MARKER),
      );
    }, 90_000);

    it("forwards immediate-exit stderr byte-for-byte and rejects typed", async () => {
      const stderrPayload = `stderr-start:${"e".repeat(300_000)}:stderr-end\n`;
      installContainerStub(
        [
          `process.stderr.write(${JSON.stringify(stderrPayload)}, () => {`,
          "  process.exit(23);",
          "});",
        ].join("\n"),
      );

      const result = await runHarness("immediate-exit");

      expect(result.code).toBe(0);
      expect(result.stderr).toEqual(Buffer.from(stderrPayload));
      const rejection = JSON.parse(result.stdout.toString()) as {
        kind: string;
        isElizaError: boolean;
        code?: string;
        context?: Record<string, unknown>;
        message: string;
      };
      expect(rejection).toMatchObject({
        kind: "rejected",
        isElizaError: true,
        code: "SANDBOX_APPLE_CONTAINER_START_EXITED",
        context: {
          containerName: "eliza-sandbox-immediate-exit",
          engine: "apple-container",
          exitCode: 23,
        },
      });
      expect(rejection.message).not.toContain(stderrPayload);
      expect(result.stdout.toString()).not.toContain("[truncated]");
      expect(result.stderr.toString()).not.toContain("[truncated]");
    }, 90_000);
  },
);
