/**
 * Process-boundary coverage for the Apple Container run-container subprocess
 * harness. Nothing is exported — the file runs at load — so this suite spawns
 * the real harness and asserts mode→name mapping, resolve vs reject stdout,
 * and the exit-code contract. Inherited-stdio forwarding of the engine is
 * owned by `sandbox-engine-run-container.test.ts`.
 */

import { spawn } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
const STDOUT_NAME = "eliza-sandbox-stdout";
const IMMEDIATE_EXIT_NAME = "eliza-sandbox-immediate-exit";
const IMAGE = "eliza-sandbox:test";
const TYPED_EXIT_CODE = 23;

let binDirectory: string | undefined;
let previousBaseline: string | undefined;

type HarnessRejection = {
  kind: string;
  isElizaError: boolean;
  code?: string;
  context?: {
    containerName?: string;
    engine?: string;
    exitCode?: number | null;
  };
  message: string;
};

function argvPath(): string {
  if (!binDirectory) {
    throw new Error("container stub directory was not installed");
  }
  return join(binDirectory, "argv.json");
}

function createBaselineDirectory(): string {
  binDirectory = mkdtempSync(join(tmpdir(), "eliza-container-harness-"));
  return binDirectory;
}

function writeExecutableStub(directory: string, body: string): void {
  const stub = join(directory, "container");
  writeFileSync(stub, `#!${process.execPath}\n${body}\n`);
  chmodSync(stub, 0o755);
}

function installStayAliveStub(): void {
  const directory = createBaselineDirectory();
  writeExecutableStub(
    directory,
    [
      `require("node:fs").writeFileSync(${JSON.stringify(join(directory, "argv.json"))}, JSON.stringify(process.argv.slice(2)));`,
      "setTimeout(() => process.exit(0), 3000);",
    ].join("\n"),
  );
}

function installImmediateExitStub(exitCode: number): void {
  const directory = createBaselineDirectory();
  writeExecutableStub(
    directory,
    [
      `require("node:fs").writeFileSync(${JSON.stringify(join(directory, "argv.json"))}, JSON.stringify(process.argv.slice(2)));`,
      `process.exit(${exitCode});`,
    ].join("\n"),
  );
}

function installEmptyBaseline(): void {
  createBaselineDirectory();
}

function installUnspawnableContainer(): void {
  const directory = createBaselineDirectory();
  const stub = join(directory, "container");
  mkdirSync(stub);
  chmodSync(stub, 0o755);
}

function recordedArgv(): string[] {
  return JSON.parse(readFileSync(argvPath(), "utf8")) as string[];
}

function runHarness(
  mode?: string,
  extraArgs: string[] = [],
): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
}> {
  const args = ["--conditions=eliza-source", "--import", "tsx", HARNESS_PATH];
  if (mode !== undefined) {
    args.push(mode, ...extraArgs);
  }
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: REPOSITORY_ROOT,
      env: {
        ...process.env,
        ELIZA_HOST_EXECUTION_BASELINE_PATH: binDirectory,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("sandbox-engine-run-container harness timed out"));
    }, 45_000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      resolveResult({
        code,
        stdout: Buffer.concat(stdout).toString(),
        stderr: Buffer.concat(stderr).toString(),
      });
    });
  });
}

function parseRejection(stdout: string): HarnessRejection {
  const line = stdout.trim().split("\n").filter(Boolean).at(-1);
  if (!line) {
    throw new Error(
      `harness produced no stdout rejection line: ${JSON.stringify(stdout)}`,
    );
  }
  return JSON.parse(line) as HarnessRejection;
}

describe.skipIf(process.platform === "win32")(
  "sandbox-engine-run-container.harness",
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
      if (previousBaseline === undefined) {
        delete process.env.ELIZA_HOST_EXECUTION_BASELINE_PATH;
      } else {
        process.env.ELIZA_HOST_EXECUTION_BASELINE_PATH = previousBaseline;
      }
    });

    it.each([
      {
        label: "stdout mode",
        mode: "stdout",
        extraArgs: [] as string[],
        name: STDOUT_NAME,
        exitCode: 0,
      },
      {
        label: "stdout mode ignoring trailing argv",
        mode: "stdout",
        extraArgs: ["ignored"],
        name: STDOUT_NAME,
        exitCode: 0,
      },
      {
        label: "immediate-exit mode that stays alive",
        mode: "immediate-exit",
        extraArgs: [],
        name: IMMEDIATE_EXIT_NAME,
        exitCode: 1,
      },
      {
        label: "omitted argv",
        mode: undefined,
        extraArgs: [],
        name: IMMEDIATE_EXIT_NAME,
        exitCode: 1,
      },
      {
        label: "unknown mode",
        mode: "garbage",
        extraArgs: [],
        name: IMMEDIATE_EXIT_NAME,
        exitCode: 1,
      },
      {
        label: "uppercase STDOUT",
        mode: "STDOUT",
        extraArgs: [],
        name: IMMEDIATE_EXIT_NAME,
        exitCode: 1,
      },
      {
        label: "empty-string mode",
        mode: "",
        extraArgs: [],
        name: IMMEDIATE_EXIT_NAME,
        exitCode: 1,
      },
    ])(
      "resolves $label with HARNESS_RESOLVED:$name and exit $exitCode",
      async ({ mode, extraArgs, name, exitCode }) => {
        installStayAliveStub();
        const result = await runHarness(mode, extraArgs);
        expect(result.code).toBe(exitCode);
        expect(result.stdout).toBe(`HARNESS_RESOLVED:${name}\n`);
        expect(recordedArgv()).toEqual(["run", "--name", name, IMAGE]);
      },
      90_000,
    );

    it("rejects stdout mode with a typed start-exit error and exit 1", async () => {
      installImmediateExitStub(TYPED_EXIT_CODE);
      const result = await runHarness("stdout");
      expect(result.code).toBe(1);
      expect(parseRejection(result.stdout)).toEqual({
        kind: "rejected",
        isElizaError: true,
        code: "SANDBOX_APPLE_CONTAINER_START_EXITED",
        context: {
          containerName: STDOUT_NAME,
          engine: "apple-container",
          exitCode: TYPED_EXIT_CODE,
        },
        message: "Apple Container exited before startup completed",
      });
      expect(recordedArgv()).toEqual(["run", "--name", STDOUT_NAME, IMAGE]);
    }, 90_000);

    it("rejects immediate-exit mode with a typed start-exit error and exit 0", async () => {
      installImmediateExitStub(TYPED_EXIT_CODE);
      const result = await runHarness("immediate-exit");
      expect(result.code).toBe(0);
      expect(parseRejection(result.stdout)).toEqual({
        kind: "rejected",
        isElizaError: true,
        code: "SANDBOX_APPLE_CONTAINER_START_EXITED",
        context: {
          containerName: IMMEDIATE_EXIT_NAME,
          engine: "apple-container",
          exitCode: TYPED_EXIT_CODE,
        },
        message: "Apple Container exited before startup completed",
      });
    }, 90_000);

    it("rejects an unknown mode with a typed start-exit error and exit 1", async () => {
      installImmediateExitStub(TYPED_EXIT_CODE);
      const result = await runHarness("not-a-mode");
      expect(result.code).toBe(1);
      const rejection = parseRejection(result.stdout);
      expect(rejection.isElizaError).toBe(true);
      expect(rejection.context?.containerName).toBe(IMMEDIATE_EXIT_NAME);
    }, 90_000);

    it("rejects omitted argv with a typed start-exit error and exit 1", async () => {
      installImmediateExitStub(TYPED_EXIT_CODE);
      const result = await runHarness();
      expect(result.code).toBe(1);
      expect(parseRejection(result.stdout).context?.containerName).toBe(
        IMMEDIATE_EXIT_NAME,
      );
    }, 90_000);

    it("rejects a missing container binary as an untyped error with exit 1 in stdout mode", async () => {
      installEmptyBaseline();
      const result = await runHarness("stdout");
      expect(result.code).toBe(1);
      const rejection = parseRejection(result.stdout);
      expect(rejection).toMatchObject({
        kind: "rejected",
        isElizaError: false,
        message: "Apple Container executable unavailable",
      });
      expect(rejection.code).toBeUndefined();
    }, 90_000);

    it("rejects a missing container binary as an untyped error with exit 1 in immediate-exit mode", async () => {
      installEmptyBaseline();
      const result = await runHarness("immediate-exit");
      expect(result.code).toBe(1);
      expect(parseRejection(result.stdout).isElizaError).toBe(false);
    }, 90_000);

    it("rejects an unspawnable container as a typed spawn failure with exit 1 in stdout mode", async () => {
      installUnspawnableContainer();
      const result = await runHarness("stdout");
      expect(result.code).toBe(1);
      const rejection = parseRejection(result.stdout);
      expect(rejection).toMatchObject({
        kind: "rejected",
        isElizaError: true,
        code: "SANDBOX_APPLE_CONTAINER_SPAWN_FAILED",
        context: {
          containerName: STDOUT_NAME,
          engine: "apple-container",
        },
        message: "Apple Container process could not be spawned",
      });
    }, 90_000);

    it("rejects an unspawnable container as a typed spawn failure with exit 0 in immediate-exit mode", async () => {
      installUnspawnableContainer();
      const result = await runHarness("immediate-exit");
      expect(result.code).toBe(0);
      expect(parseRejection(result.stdout)).toMatchObject({
        kind: "rejected",
        isElizaError: true,
        code: "SANDBOX_APPLE_CONTAINER_SPAWN_FAILED",
        context: {
          containerName: IMMEDIATE_EXIT_NAME,
          engine: "apple-container",
        },
      });
    }, 90_000);
  },
);
