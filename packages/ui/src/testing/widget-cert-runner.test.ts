/**
 * Exercises the certification executable in isolated subprocesses. Missing
 * dependencies, invalid fixture source, and unavailable browsers must fail
 * without leaving an earlier run's passing certification artifacts behind.
 */
// @vitest-environment node
import { spawn } from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const uiRoot = resolve(here, "../..");
const temporaryDirectories: string[] = [];

async function prepareRun(withDependencies: boolean) {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "eliza-widget-cert-"));
  temporaryDirectories.push(temporaryRoot);
  const sourceRoot = join(temporaryRoot, "ui/src");
  const fixtureDirectory = join(sourceRoot, "testing/__e2e__");
  const outDir = join(fixtureDirectory, "output-widget-cert");
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, "widget-cert.json"), '{"passed":true}');
  await writeFile(join(outDir, "widget-cert.txt"), "Previous run passed");
  await writeFile(join(outDir, "chromium.png"), "old screenshot");
  const runner = join(fixtureDirectory, "run-widget-cert-e2e.mjs");
  await copyFile(join(here, "__e2e__/run-widget-cert-e2e.mjs"), runner);
  if (withDependencies) {
    await symlink(
      resolve(uiRoot, "../../node_modules"),
      join(temporaryRoot, "node_modules"),
      "dir",
    );
    await symlink(
      join(uiRoot, "node_modules"),
      join(temporaryRoot, "ui/node_modules"),
      "dir",
    );
    await symlink(
      join(here, "e2e-runner"),
      join(sourceRoot, "testing/e2e-runner"),
      "dir",
    );
    await symlink(
      join(uiRoot, "src/styles"),
      join(sourceRoot, "styles"),
      "dir",
    );
  }
  return { runner, fixtureDirectory, outDir, temporaryRoot };
}

async function runToFailure(runner: string, env = process.env) {
  const result = await new Promise<{
    code: number | null;
    stderr: string;
  }>((resolve, reject) => {
    const child = spawn(process.execPath, [runner], {
      env,
      stdio: ["ignore", "ignore", "pipe"],
      timeout: 30_000,
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stderr }));
  });
  if (result.code === 0)
    throw new Error("Certification unexpectedly succeeded.");
  return result;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("widget certification command failures", () => {
  it("fails missing dependencies and clears previous certification evidence", async () => {
    const { runner, outDir } = await prepareRun(false);
    const failure = await runToFailure(runner);
    expect(failure.code).toBe(1);
    expect(failure.stderr).toContain("playwright");
    expect(await readdir(outDir)).toEqual([]);
  });

  it("fails a real fixture bundling error and clears previous evidence", async () => {
    const { runner, fixtureDirectory, outDir } = await prepareRun(true);
    await writeFile(
      join(fixtureDirectory, "widget-cert-fixture.tsx"),
      "export const broken = <;",
    );
    const failure = await runToFailure(runner);
    expect(failure.code).toBe(1);
    expect(failure.stderr).toContain("Build failed");
    expect(await readdir(outDir)).toEqual([]);
  });

  it("fails a missing browser after bundling instead of publishing old evidence", async () => {
    const { runner, fixtureDirectory, outDir, temporaryRoot } =
      await prepareRun(true);
    await writeFile(
      join(fixtureDirectory, "widget-cert-fixture.tsx"),
      "document.body.dataset.fixture = 'bundled';",
    );
    const failure = await runToFailure(runner, {
      ...process.env,
      PLAYWRIGHT_BROWSERS_PATH: join(temporaryRoot, "missing-browsers"),
    });
    expect(failure.code).toBe(1);
    expect(failure.stderr).toContain("browserType.launch");
    expect(await readdir(outDir)).toEqual(["widget-cert.html"]);
  }, 30_000);
});
