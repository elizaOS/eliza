/**
 * Proves run-turbo's bounded retry for the Windows 0xC0000142
 * (STATUS_DLL_INIT_FAILED) child-process crash class: exactly one retry, only
 * when the crash signature is present in Turbo output, resumable from the
 * Turbo cache, loud on stderr, and off by default on non-Windows platforms.
 * Real subprocesses via the RUN_TURBO_BIN seam — the fake turbo records each
 * invocation so attempt counts are observable, no mocks.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "../../..");
const runTurbo = join(repoRoot, "packages/scripts/run-turbo.mjs");
const tempDirs: string[] = [];

/**
 * Fake turbo: appends one line to the attempts file per invocation, then
 * follows a per-attempt script of exit behaviors — "crash" prints the
 * 0xC0000142 failure line Turbo emits and exits 1, "fail" exits 1 with an
 * ordinary error line, "ok" exits 0.
 */
async function fixture(behaviors: Array<"crash" | "fail" | "ok">) {
  const dir = await mkdtemp(join(tmpdir(), "run-turbo-init-crash-"));
  tempDirs.push(dir);
  const attemptsFile = join(dir, "attempts.txt");
  const fakeTurbo = join(dir, "fake-turbo.mjs");
  await writeFile(
    fakeTurbo,
    [
      'import { appendFileSync, readFileSync } from "node:fs";',
      `const attemptsFile = ${JSON.stringify(attemptsFile)};`,
      'appendFileSync(attemptsFile, "x");',
      'const attempt = readFileSync(attemptsFile, "utf8").length;',
      `const behaviors = ${JSON.stringify(behaviors)};`,
      'const behavior = behaviors[attempt - 1] ?? "ok";',
      'if (behavior === "crash") {',
      '  console.log("@elizaos/plugin-example#build:  ERROR  command (D:/a/eliza) bun.exe run build exited (-1073741502)");',
      "  process.exit(1);",
      "}",
      'if (behavior === "fail") {',
      '  console.log("@elizaos/plugin-example#build:  ERROR  command failed: real compile error");',
      "  process.exit(1);",
      "}",
      "process.exit(0);",
    ].join("\n"),
  );
  return { fakeTurbo, attemptsFile };
}

async function invoke(fakeTurbo: string, env: Record<string, string> = {}) {
  const child = Bun.spawn([process.execPath, runTurbo, "run", "lint"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      RUN_TURBO_BIN: fakeTurbo,
      RUN_TURBO_FORCE_INIT_CRASH_RETRY: "1",
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  await child.exited;
  return {
    exitCode: child.exitCode,
    stdout: await new Response(child.stdout).text(),
    stderr: await new Response(child.stderr).text(),
  };
}

async function attempts(attemptsFile: string): Promise<number> {
  try {
    return (await readFile(attemptsFile, "utf8")).length;
  } catch {
    return 0;
  }
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("run-turbo Windows init-crash retry", () => {
  test("retries exactly once on the 0xC0000142 signature and succeeds from the second attempt", async () => {
    const { fakeTurbo, attemptsFile } = await fixture(["crash", "ok"]);

    const result = await invoke(fakeTurbo);

    expect(result.exitCode).toBe(0);
    expect(await attempts(attemptsFile)).toBe(2);
    expect(result.stderr).toContain("STATUS_DLL_INIT_FAILED");
    expect(result.stderr).toContain("Retrying once");
  });

  test("a persistent crash still fails after the single retry", async () => {
    const { fakeTurbo, attemptsFile } = await fixture(["crash", "crash"]);

    const result = await invoke(fakeTurbo);

    expect(result.exitCode).toBe(1);
    expect(await attempts(attemptsFile)).toBe(2);
  });

  test("an ordinary failure without the signature is never retried", async () => {
    const { fakeTurbo, attemptsFile } = await fixture(["fail", "ok"]);

    const result = await invoke(fakeTurbo);

    expect(result.exitCode).toBe(1);
    expect(await attempts(attemptsFile)).toBe(1);
    expect(result.stderr).not.toContain("Retrying once");
  });

  test("success passes through on the first attempt", async () => {
    const { fakeTurbo, attemptsFile } = await fixture(["ok"]);

    const result = await invoke(fakeTurbo);

    expect(result.exitCode).toBe(0);
    expect(await attempts(attemptsFile)).toBe(1);
  });

  test("turbo output still streams through to the caller", async () => {
    const { fakeTurbo } = await fixture(["fail"]);

    const result = await invoke(fakeTurbo);

    expect(result.stdout).toContain("real compile error");
  });

  test("RUN_TURBO_NO_INIT_CRASH_RETRY=1 disables the retry entirely", async () => {
    const { fakeTurbo, attemptsFile } = await fixture(["crash", "ok"]);

    const result = await invoke(fakeTurbo, {
      RUN_TURBO_NO_INIT_CRASH_RETRY: "1",
    });

    expect(result.exitCode).toBe(1);
    expect(await attempts(attemptsFile)).toBe(1);
  });

  test("without the force flag the retry stays Windows-only", async () => {
    const { fakeTurbo, attemptsFile } = await fixture(["crash", "ok"]);

    const child = Bun.spawn([process.execPath, runTurbo, "run", "lint"], {
      cwd: repoRoot,
      env: { ...process.env, RUN_TURBO_BIN: fakeTurbo },
      stdout: "pipe",
      stderr: "pipe",
    });
    await child.exited;

    if (process.platform === "win32") {
      expect(child.exitCode).toBe(0);
      expect(await attempts(attemptsFile)).toBe(2);
    } else {
      expect(child.exitCode).toBe(1);
      expect(await attempts(attemptsFile)).toBe(1);
    }
  });
});
