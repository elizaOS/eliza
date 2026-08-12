/**
 * Exercises the run-turbo concurrency override through real subprocesses and
 * a fake Turbo binary so invalid environment input cannot reach the task graph.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "../lib/spawn-sync-captured.mjs";

const repoRoot = resolve(import.meta.dir, "../../..");
const runTurbo = join(repoRoot, "packages/scripts/run-turbo.mjs");
const tempDirs: string[] = [];

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "run-turbo-concurrency-"));
  tempDirs.push(dir);
  const argvFile = join(dir, "argv.json");
  const fakeTurbo = join(dir, "fake-turbo.mjs");
  await writeFile(
    fakeTurbo,
    `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2)));\n`,
  );
  return { argvFile, fakeTurbo };
}

function invoke(
  fakeTurbo: string,
  concurrency: string | undefined,
  args = ["run", "lint", "--concurrency", "8"],
) {
  const env = { ...process.env, RUN_TURBO_BIN: fakeTurbo };
  if (concurrency === undefined) {
    delete env.RUN_TURBO_CONCURRENCY;
  } else {
    env.RUN_TURBO_CONCURRENCY = concurrency;
  }

  return spawnSync("node", [runTurbo, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env,
  });
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("run-turbo concurrency override", () => {
  test.each([undefined, ""])(
    "preserves CLI concurrency when the environment value is %s",
    async (concurrency) => {
      const { argvFile, fakeTurbo } = await fixture();

      const result = invoke(fakeTurbo, concurrency);

      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(await readFile(argvFile, "utf8"))).toEqual(
        expect.arrayContaining(["--concurrency", "8"]),
      );
    },
  );

  test.each(["1", "4", String(Number.MAX_SAFE_INTEGER)])(
    "injects a valid positive safe integer (%s)",
    async (concurrency) => {
      const { argvFile, fakeTurbo } = await fixture();

      const result = invoke(fakeTurbo, concurrency);

      expect(result.status, result.stderr).toBe(0);
      const argv = JSON.parse(await readFile(argvFile, "utf8"));
      expect(argv).toContain(`--concurrency=${concurrency}`);
      expect(argv).not.toContain("--concurrency");
      expect(argv).not.toContain("8");
    },
  );

  test("replaces an equals-form CLI concurrency flag", async () => {
    const { argvFile, fakeTurbo } = await fixture();

    const result = invoke(fakeTurbo, "5", ["run", "lint", "--concurrency=8"]);

    expect(result.status, result.stderr).toBe(0);
    const argv = JSON.parse(await readFile(argvFile, "utf8"));
    expect(argv).toContain("--concurrency=5");
    expect(argv).not.toContain("--concurrency=8");
  });

  test.each([
    " ",
    " 4 ",
    "0",
    "-1",
    "+3",
    "1.5",
    "1e2",
    "3junk",
    "NaN",
    "Infinity",
    String(Number.MAX_SAFE_INTEGER + 1),
  ])("rejects %j before Turbo starts", async (concurrency) => {
    const { argvFile, fakeTurbo } = await fixture();

    const result = invoke(fakeTurbo, concurrency);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "[run-turbo] RUN_TURBO_CONCURRENCY must be a positive safe-integer decimal",
    );
    await expect(readFile(argvFile, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  test("injects the override for a bare Turbo invocation", async () => {
    const { argvFile, fakeTurbo } = await fixture();

    const result = invoke(fakeTurbo, "6", ["lint"]);

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(await readFile(argvFile, "utf8"))).toEqual(
      expect.arrayContaining(["lint", "--concurrency=6"]),
    );
  });

  test("does not rewrite task pass-through concurrency after bare --", async () => {
    const { argvFile, fakeTurbo } = await fixture();

    const result = invoke(fakeTurbo, "4", [
      "run",
      "lint",
      "--",
      "--concurrency",
      "8",
    ]);

    expect(result.status, result.stderr).toBe(0);
    const argv = JSON.parse(await readFile(argvFile, "utf8"));
    const sep = argv.indexOf("--");
    expect(sep).toBeGreaterThan(-1);
    const owned = argv.slice(0, sep);
    const pass = argv.slice(sep);
    expect(owned.filter((a: string) => a.startsWith("--concurrency")).length).toBe(
      1,
    );
    expect(owned).toContain("--concurrency=4");
    expect(pass).toEqual(["--", "--concurrency", "8"]);
  });

  test("removes every pre-separator concurrency occurrence before injecting one override", async () => {
    const { argvFile, fakeTurbo } = await fixture();

    const result = invoke(fakeTurbo, "4", [
      "run",
      "lint",
      "--concurrency",
      "8",
      "--concurrency=9",
    ]);

    expect(result.status, result.stderr).toBe(0);
    const argv = JSON.parse(await readFile(argvFile, "utf8"));
    const concurrencyFlags = argv.filter(
      (a: string) => a === "--concurrency" || a.startsWith("--concurrency="),
    );
    expect(concurrencyFlags).toEqual(["--concurrency=4"]);
    expect(argv).not.toContain("8");
    expect(argv).not.toContain("9");
    expect(argv).not.toContain("--concurrency=9");
  });
});
