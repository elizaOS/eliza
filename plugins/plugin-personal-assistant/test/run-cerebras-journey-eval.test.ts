/**
 * Verifies the journey-eval CLI's credential, environment, and real subprocess
 * boundaries without invoking the live model suite.
 */

import { EventEmitter } from "node:events";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createJourneyEvalInvocation,
  isDirectInvocation,
  resolveJourneyEvalPaths,
  runCerebrasJourneyEval,
  waitForChild,
} from "../scripts/run-cerebras-journey-eval.mjs";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function createFixtureRunner(exitCode = 0): string {
  const directory = mkdtempSync(path.join(tmpdir(), "cerebras-eval-runner-"));
  temporaryDirectories.push(directory);
  const runner = path.join(directory, "bunx");
  writeFileSync(
    runner,
    [
      "#!/bin/sh",
      'printf "%s\\n" "$@" > "$ELIZA_TEST_ARGS"',
      'printf "%s\\n" "$PWD" > "$ELIZA_TEST_CWD"',
      `exit ${exitCode}`,
      "",
    ].join("\n"),
  );
  chmodSync(runner, 0o755);
  return directory;
}

describe("Cerebras journey eval runner", () => {
  it("resolves the repository and package environment candidates", () => {
    const paths = resolveJourneyEvalPaths(
      new URL(
        "file:///workspace/eliza/plugins/plugin-personal-assistant/scripts/run.mjs",
      ),
    );

    expect(paths).toEqual({
      envCandidates: [
        "/workspace/eliza/.env",
        "/workspace/eliza/plugins/plugin-personal-assistant/.env",
      ],
      workspaceRoot: "/workspace",
    });
  });

  it("returns a failure before spawning when credentials remain absent", async () => {
    const errors: string[] = [];
    let spawned = false;

    const code = await runCerebrasJourneyEval({
      env: {},
      paths: { envCandidates: [], workspaceRoot: "/workspace" },
      spawnProcess() {
        spawned = true;
        throw new Error("credential gate did not stop the child process");
      },
      writeError(message: string) {
        errors.push(message);
      },
      writeInfo() {},
    });

    expect({ code, errors, spawned }).toEqual({
      code: 1,
      errors: [expect.stringContaining("CEREBRAS_API_KEY")],
      spawned: false,
    });
  });

  it("loads dotenv and drives a real child process with the live-suite arguments", async () => {
    const directory = createFixtureRunner();
    const envFile = path.join(directory, ".env");
    const argsFile = path.join(directory, "args.txt");
    const cwdFile = path.join(directory, "cwd.txt");
    writeFileSync(envFile, "CEREBRAS_API_KEY=fixture-key\n");
    const env: Record<string, string | undefined> = {
      PATH: `${directory}:${process.env.PATH}`,
      ELIZA_TEST_ARGS: argsFile,
      ELIZA_TEST_CWD: cwdFile,
    };

    const code = await runCerebrasJourneyEval({
      env,
      paths: { envCandidates: [envFile], workspaceRoot: directory },
      writeError() {},
      writeInfo() {},
    });

    expect(code).toBe(0);
    expect(env.CEREBRAS_API_KEY).toBe("fixture-key");
    expect(readFileSync(argsFile, "utf8").trim().split("\n")).toEqual([
      "vitest",
      "run",
      "--config",
      "eliza/packages/test/vitest/live-e2e.config.ts",
      "eliza/plugins/plugin-personal-assistant/test/journey-cerebras-eval.live.e2e.test.ts",
    ]);
    expect(readFileSync(cwdFile, "utf8").trim()).toBe(directory);
  });

  it("propagates a real child process failure", async () => {
    const directory = createFixtureRunner(7);
    const env: Record<string, string | undefined> = {
      CEREBRAS_API_KEY: "fixture-key",
      PATH: `${directory}:${process.env.PATH}`,
      ELIZA_TEST_ARGS: path.join(directory, "args.txt"),
      ELIZA_TEST_CWD: path.join(directory, "cwd.txt"),
    };

    await expect(
      runCerebrasJourneyEval({
        env,
        paths: { envCandidates: [], workspaceRoot: directory },
        writeError() {},
        writeInfo() {},
      }),
    ).resolves.toBe(7);
  });

  it("treats signal-only child completion as failure", async () => {
    const child = new EventEmitter();
    const completion = waitForChild(child);
    child.emit("exit", null);
    await expect(completion).resolves.toBe(1);
  });

  it("builds the stable Vitest command and detects direct invocation", () => {
    const invocation = createJourneyEvalInvocation("/workspace", {
      KEY: "value",
    });
    expect(invocation.command).toBe("bunx");
    expect(invocation.options.cwd).toBe("/workspace");
    expect(invocation.args).toContain(
      "eliza/packages/test/vitest/live-e2e.config.ts",
    );

    const moduleUrl = new URL("file:///workspace/runner.mjs");
    expect(
      isDirectInvocation(["node", "/workspace/runner.mjs"], moduleUrl),
    ).toBe(true);
    expect(
      isDirectInvocation(["node", "/workspace/other.mjs"], moduleUrl),
    ).toBe(false);
  });
});
