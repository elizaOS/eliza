/**
 * Offline unit tests for RUN_TURBO_CONCURRENCY fail-closed resolution and argv
 * injection. Pure helpers plus a real subprocess seam (RUN_TURBO_BIN) so the
 * runner rejects typos before Turbo starts and still injects valid caps.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  applyTurboConcurrency,
  parsePositiveSafeInteger,
  resolveTurboConcurrency,
} from "../lib/run-turbo-concurrency.mjs";
import { spawnSync } from "../lib/spawn-sync-captured.mjs";

const repoRoot = resolve(import.meta.dir, "../../..");
const runTurbo = join(repoRoot, "packages/scripts/run-turbo.mjs");
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
}, 30_000);

describe("parsePositiveSafeInteger", () => {
  test("accepts complete positive safe-integer decimals", () => {
    expect(parsePositiveSafeInteger("1", "X")).toBe(1);
    expect(parsePositiveSafeInteger("4", "X")).toBe(4);
    expect(parsePositiveSafeInteger(42, "X")).toBe(42);
  });

  test("accepts surrounding whitespace after trim", () => {
    expect(parsePositiveSafeInteger(" 4 ", "X")).toBe(4);
  });

  test("rejects malformed, signed, fractional, zero, and non-finite values", () => {
    for (const value of [
      "abc",
      "3junk",
      "1.5",
      "+2",
      "-1",
      "0",
      "",
      " ",
      "08",
      Number.NaN,
      Number.POSITIVE_INFINITY,
      1.5,
      0,
      -3,
    ]) {
      expect(() => parsePositiveSafeInteger(value, "LABEL")).toThrow(/LABEL/);
    }
  });
});

describe("resolveTurboConcurrency", () => {
  test("returns null when override is unset, empty, or whitespace-only", () => {
    expect(resolveTurboConcurrency({})).toBeNull();
    expect(resolveTurboConcurrency({ RUN_TURBO_CONCURRENCY: "" })).toBeNull();
    expect(
      resolveTurboConcurrency({ RUN_TURBO_CONCURRENCY: "   " }),
    ).toBeNull();
  });

  test("accepts valid positive integers", () => {
    expect(resolveTurboConcurrency({ RUN_TURBO_CONCURRENCY: "4" })).toBe(4);
    expect(resolveTurboConcurrency({ RUN_TURBO_CONCURRENCY: " 8 " })).toBe(8);
  });

  test("rejects explicit malformed overrides", () => {
    for (const value of ["abc", "0", "-1", "1.5", "4x", "+2"]) {
      expect(() =>
        resolveTurboConcurrency({ RUN_TURBO_CONCURRENCY: value }),
      ).toThrow(/RUN_TURBO_CONCURRENCY/);
    }
  });
});

describe("applyTurboConcurrency", () => {
  test("leaves args unchanged when concurrency is null", () => {
    const args = ["run", "lint", "--filter=x"];
    expect(applyTurboConcurrency(args, null)).toEqual(args);
  });

  test("inserts after run when no concurrency flag is present", () => {
    expect(applyTurboConcurrency(["run", "lint"], 4)).toEqual([
      "run",
      "--concurrency=4",
      "lint",
    ]);
  });

  test("appends when there is no run command word", () => {
    expect(applyTurboConcurrency(["lint"], 2)).toEqual([
      "lint",
      "--concurrency=2",
    ]);
  });

  test("replaces existing --concurrency= form", () => {
    expect(
      applyTurboConcurrency(["run", "--concurrency=8", "lint"], 4),
    ).toEqual(["run", "--concurrency=4", "lint"]);
  });

  test("replaces existing --concurrency value form", () => {
    expect(
      applyTurboConcurrency(["run", "--concurrency", "8", "lint"], 4),
    ).toEqual(["run", "--concurrency=4", "lint"]);
  });
});

describe("run-turbo.mjs RUN_TURBO_CONCURRENCY integration", () => {
  async function fixtureFakeTurbo() {
    const dir = await mkdtemp(join(tmpdir(), "run-turbo-concurrency-"));
    tempDirs.push(dir);
    const argvFile = join(dir, "argv.json");
    const fakeTurbo = join(dir, "fake-turbo.mjs");
    await writeFile(
      fakeTurbo,
      [
        'import { writeFileSync } from "node:fs";',
        `writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2)));`,
        "process.exit(0);",
      ].join("\n"),
    );
    return { fakeTurbo, argvFile };
  }

  function invoke(
    fakeTurbo: string,
    env: Record<string, string | undefined> = {},
  ) {
    const child = spawnSync("node", [runTurbo, "run", "lint"], {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        RUN_TURBO_BIN: fakeTurbo,
        RUN_TURBO_NO_INIT_CRASH_RETRY: "1",
        ...env,
      },
      timeout: 30_000,
    });
    return {
      exitCode: child.status,
      stdout: child.stdout ?? "",
      stderr: child.stderr ?? "",
    };
  }

  test("injects a valid env concurrency cap into Turbo argv", async () => {
    const { fakeTurbo, argvFile } = await fixtureFakeTurbo();
    const result = invoke(fakeTurbo, { RUN_TURBO_CONCURRENCY: "4" });
    expect(result.exitCode).toBe(0);
    const argv = JSON.parse(await readFile(argvFile, "utf8")) as string[];
    expect(argv).toContain("--concurrency=4");
  });

  test("replaces a CLI concurrency flag when the env cap is set", async () => {
    const { fakeTurbo, argvFile } = await fixtureFakeTurbo();
    const child = spawnSync(
      "node",
      [runTurbo, "run", "--concurrency=8", "lint"],
      {
        cwd: repoRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          RUN_TURBO_BIN: fakeTurbo,
          RUN_TURBO_NO_INIT_CRASH_RETRY: "1",
          RUN_TURBO_CONCURRENCY: "4",
        },
        timeout: 30_000,
      },
    );
    expect(child.status).toBe(0);
    const argv = JSON.parse(await readFile(argvFile, "utf8")) as string[];
    expect(argv).toContain("--concurrency=4");
    expect(argv).not.toContain("--concurrency=8");
  });

  test("rejects malformed RUN_TURBO_CONCURRENCY before Turbo starts", async () => {
    const { fakeTurbo, argvFile } = await fixtureFakeTurbo();
    for (const value of ["abc", "0", "-1", "1.5", "4x"]) {
      const result = invoke(fakeTurbo, { RUN_TURBO_CONCURRENCY: value });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toMatch(/RUN_TURBO_CONCURRENCY/);
      expect(result.stderr).toMatch(/\[run-turbo\]/);
    }
    // Fake turbo must never have been invoked.
    await expect(readFile(argvFile, "utf8")).rejects.toThrow();
  });

  test("omits env concurrency injection when the override is blank", async () => {
    const { fakeTurbo, argvFile } = await fixtureFakeTurbo();
    const result = invoke(fakeTurbo, { RUN_TURBO_CONCURRENCY: "" });
    expect(result.exitCode).toBe(0);
    const argv = JSON.parse(await readFile(argvFile, "utf8")) as string[];
    expect(argv.some((arg) => arg.startsWith("--concurrency"))).toBe(false);
  });
});
