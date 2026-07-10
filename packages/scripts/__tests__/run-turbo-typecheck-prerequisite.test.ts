/**
 * Verifies Turbo typecheck invocations materialize generated declarations
 * before scheduling, across every argv shape run-turbo accepts: `run <task>`,
 * bare `<task>`, and flags in any position (#15847). Real subprocesses, no
 * mocks — the fixture generator stands in for generate-keywords.mjs only so
 * tests can observe invocation counts and argv without touching src/.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "../../..");
const runTurbo = join(repoRoot, "packages/scripts/run-turbo.mjs");
const keywordGenerator = join(
  repoRoot,
  "packages/shared/scripts/generate-keywords.mjs",
);
const tempDirs: string[] = [];

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "run-turbo-prerequisite-"));
  tempDirs.push(dir);
  const marker = join(dir, "marker.txt");
  const argvFile = join(dir, "argv.json");
  const generator = join(dir, "generator.mjs");
  await writeFile(
    generator,
    `import { appendFileSync, writeFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(marker)}, "generated\\n");\nwriteFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2)));\nprocess.exit(Number(process.env.GENERATOR_EXIT ?? 0));\n`,
  );
  return { generator, marker, argvFile };
}

async function invoke(args: string[], generator: string, exitCode = 0) {
  const child = Bun.spawn([process.execPath, runTurbo, ...args], {
    cwd: repoRoot,
    env: {
      ...process.env,
      RUN_TURBO_KEYWORD_GENERATOR: generator,
      RUN_TURBO_PREPARE_CHECK_ONLY: "1",
      GENERATOR_EXIT: String(exitCode),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  await child.exited;
  return child.exitCode;
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("run-turbo typecheck prerequisites", () => {
  test("runs the generator once before a typecheck task", async () => {
    const { generator, marker } = await fixture();

    expect(
      await invoke(["run", "typecheck", "--concurrency=8"], generator),
    ).toBe(0);
    expect(await readFile(marker, "utf8")).toBe("generated\n");
  });

  test("runs the generator once for a mixed typecheck and lint graph", async () => {
    const { generator, marker } = await fixture();

    expect(await invoke(["run", "typecheck", "lint"], generator)).toBe(0);
    expect(await readFile(marker, "utf8")).toBe("generated\n");
  });

  test("runs the generator when flags precede the task list", async () => {
    const { generator, marker } = await fixture();

    expect(
      await invoke(["run", "--filter=@elizaos/core", "typecheck"], generator),
    ).toBe(0);
    expect(await readFile(marker, "utf8")).toBe("generated\n");
  });

  test("runs the generator for a bare typecheck invocation without `run`", async () => {
    const { generator, marker } = await fixture();

    expect(await invoke(["typecheck"], generator)).toBe(0);
    expect(await readFile(marker, "utf8")).toBe("generated\n");
  });

  test("runs the generator for a bare invocation with flags on both sides", async () => {
    const { generator, marker } = await fixture();

    expect(
      await invoke(
        ["--filter=@elizaos/core", "typecheck", "--concurrency=4"],
        generator,
      ),
    ).toBe(0);
    expect(await readFile(marker, "utf8")).toBe("generated\n");
  });

  test("invokes the generator with an empty argv (it rejects arguments)", async () => {
    const { generator, argvFile } = await fixture();

    expect(await invoke(["run", "typecheck"], generator)).toBe(0);
    expect(JSON.parse(await readFile(argvFile, "utf8"))).toEqual([]);
  });

  test("does not generate declarations for unrelated Turbo tasks", async () => {
    const { generator, marker } = await fixture();

    expect(await invoke(["run", "lint"], generator)).toBe(0);
    await expect(readFile(marker, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  test("does not generate declarations for bare unrelated tasks with flags", async () => {
    const { generator, marker } = await fixture();

    expect(await invoke(["lint", "--filter=@elizaos/core"], generator)).toBe(0);
    await expect(readFile(marker, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  test("does not treat pass-through args after `--` as tasks", async () => {
    const { generator, marker } = await fixture();

    expect(await invoke(["run", "lint", "--", "typecheck"], generator)).toBe(0);
    await expect(readFile(marker, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  test("fails before scheduling when generation fails", async () => {
    const { generator } = await fixture();

    expect(await invoke(["run", "typecheck"], generator, 7)).toBe(7);
  });

  test("fails before scheduling when generation fails on a bare invocation", async () => {
    const { generator } = await fixture();

    expect(await invoke(["typecheck"], generator, 7)).toBe(7);
  });
});

describe("generate-keywords argv contract", () => {
  test("rejects the removed --target flag before writing anything", async () => {
    const child = Bun.spawn(
      [process.execPath, keywordGenerator, "--target", "ts"],
      {
        cwd: repoRoot,
        env: process.env,
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    await child.exited;
    const stderr = await new Response(child.stderr).text();

    expect(child.exitCode).toBe(1);
    expect(stderr).toContain("takes no arguments");
  });
});
