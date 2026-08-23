/**
 * Verifies Turbo build/typecheck invocations materialize generated modules
 * before scheduling, including the filtered agent-image graph from an empty
 * generated tree. Subprocess fixtures isolate production source outputs.
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "../lib/spawn-sync-captured.mjs";

const repoRoot = resolve(import.meta.dir, "../../..");
const runTurbo = join(repoRoot, "packages/scripts/run-turbo.mjs");
const keywordGenerator = join(
  repoRoot,
  "packages/shared/scripts/generate-keywords.mjs",
);
const keywordSources = join(repoRoot, "packages/shared/src/i18n/keywords");
const tempDirs: string[] = [];

const agentImageFilters = [
  "@elizaos/app",
  "@elizaos/agent",
  "@elizaos/plugin-sql",
  "@elizaos/plugin-video",
  "@elizaos/plugin-agent-skills",
  "@elizaos/plugin-pdf",
  "@elizaos/plugin-browser",
  "@elizaos/plugin-capacitor-bridge",
  "@elizaos/plugin-coding-tools",
  "@elizaos/plugin-native-filesystem",
  "@elizaos/plugin-commands",
  "@elizaos/plugin-computeruse",
  "@elizaos/plugin-discord",
  "@elizaos/plugin-elizacloud",
  "@elizaos/plugin-imessage",
  "@elizaos/plugin-local-inference",
  "@elizaos/plugin-mcp",
  "@elizaos/plugin-telegram",
  "@elizaos/plugin-whatsapp",
  "@elizaos/plugin-wallet",
  "@elizaos/plugin-workflow",
];

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
}, 30_000);

describe("run-turbo generated-source prerequisites", () => {
  test("runs the generator once before a build task", async () => {
    const { generator, marker } = await fixture();

    expect(
      await invoke(["run", "build", "--filter=@elizaos/app"], generator),
    ).toBe(0);
    expect(await readFile(marker, "utf8")).toBe("generated\n");
  });

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

describe("filtered build generated outputs", () => {
  test("direct core builds never accept existing generated output as fresh", async () => {
    const manifest = JSON.parse(
      await readFile(join(repoRoot, "packages/core/package.json"), "utf8"),
    );

    expect(manifest.scripts.prebuild).toContain(
      "node ../shared/scripts/generate-keywords.mjs",
    );
    expect(manifest.scripts.prebuild).not.toContain("[ -s");
  });

  test("materializes every consumed output before the agent-image graph starts", async () => {
    const dir = await mkdtemp(join(tmpdir(), "run-turbo-filtered-build-"));
    tempDirs.push(dir);

    const copiedRunTurbo = join(dir, "packages/scripts/run-turbo.mjs");
    const copiedGenerator = join(
      dir,
      "packages/shared/scripts/generate-keywords.mjs",
    );
    const copiedKeywords = join(dir, "packages/shared/src/i18n/keywords");
    const fakeTurbo = join(dir, "fake-turbo.mjs");
    const turboArgsFile = join(dir, "turbo-args.json");
    const outputs = [
      "packages/shared/src/i18n/generated/validation-keyword-data.ts",
      "packages/shared/src/i18n/generated/validation-keyword-data.js",
      "packages/core/src/i18n/generated/validation-keyword-data.ts",
    ];

    await mkdir(join(dir, "packages/scripts"), { recursive: true });
    await mkdir(join(dir, "packages/shared/scripts"), { recursive: true });
    await copyFile(runTurbo, copiedRunTurbo);
    await copyFile(keywordGenerator, copiedGenerator);
    await cp(keywordSources, copiedKeywords, { recursive: true });
    await writeFile(
      fakeTurbo,
      `import { readFileSync, writeFileSync } from "node:fs";\nimport { resolve } from "node:path";\nconst outputs = ${JSON.stringify(outputs)};\nfor (const output of outputs) {\n  const source = readFileSync(resolve(output), "utf8");\n  if (!source.includes("VALIDATION_KEYWORD_DOCS")) {\n    throw new Error(\`generated output is incomplete: \${output}\`);\n  }\n}\nwriteFileSync(${JSON.stringify(turboArgsFile)}, JSON.stringify(process.argv.slice(2)));\n`,
    );

    for (const output of outputs) {
      await expect(readFile(join(dir, output), "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
    }

    const args = [
      "run",
      "build",
      "--concurrency=8",
      ...agentImageFilters.map((filter) => `--filter=${filter}`),
    ];
    const child = Bun.spawn([process.execPath, copiedRunTurbo, ...args], {
      cwd: dir,
      env: {
        ...process.env,
        RUN_TURBO_BIN: fakeTurbo,
        RUN_TURBO_BUN_LOCKFILE: join(dir, "absent-bun.lock"),
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    await child.exited;
    const stderr = await new Response(child.stderr).text();

    expect(child.exitCode, stderr).toBe(0);
    for (const output of outputs) {
      expect(await readFile(join(dir, output), "utf8")).toContain(
        "VALIDATION_KEYWORD_DOCS",
      );
    }
    expect(
      (await readdir(join(dir, "packages/shared/src/i18n/generated"))).sort(),
    ).toEqual(["validation-keyword-data.js", "validation-keyword-data.ts"]);
    expect(JSON.parse(await readFile(turboArgsFile, "utf8"))).toEqual(
      expect.arrayContaining([
        "run",
        "build",
        "--concurrency=8",
        ...agentImageFilters.map((filter) => `--filter=${filter}`),
      ]),
    );
  }, 30_000);
});

describe("generate-keywords argv contract", () => {
  test("rejects the removed --target flag before writing anything", async () => {
    const child = spawnSync("node", [keywordGenerator, "--target", "ts"], {
      cwd: repoRoot,
      encoding: "utf8",
      env: process.env,
    });

    expect(child.status).toBe(1);
    expect(child.stderr).toContain("takes no arguments");
  });
});
