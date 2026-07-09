/** Verifies Turbo typecheck invocations materialize generated declarations before scheduling. */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "../../..");
const runTurbo = join(repoRoot, "packages/scripts/run-turbo.mjs");
const tempDirs: string[] = [];

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "run-turbo-prerequisite-"));
  tempDirs.push(dir);
  const marker = join(dir, "marker.txt");
  const generator = join(dir, "generator.mjs");
  await writeFile(
    generator,
    `import { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(marker)}, "generated\\n");\nprocess.exit(Number(process.env.GENERATOR_EXIT ?? 0));\n`,
  );
  return { generator, marker };
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

  test("does not generate declarations for unrelated Turbo tasks", async () => {
    const { generator, marker } = await fixture();

    expect(await invoke(["run", "lint"], generator)).toBe(0);
    await expect(readFile(marker, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  test("fails before scheduling when generation fails", async () => {
    const { generator } = await fixture();

    expect(await invoke(["run", "typecheck"], generator, 7)).toBe(7);
  });
});
