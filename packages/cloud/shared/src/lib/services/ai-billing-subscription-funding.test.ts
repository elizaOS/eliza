/**
 * Runs the mock-heavy AI funding contract in a child process so Bun's global
 * module replacements cannot leak into neighboring service suites.
 */
import { expect, test } from "bun:test";

test("AI billing subscription funding contract passes in isolation", async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      "test",
      "--config=/dev/null",
      "--timeout=60000",
      `${import.meta.dir}/ai-billing-subscription-funding.fixture.mts`,
    ],
    {
      cwd: import.meta.dir,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(exitCode, `${stdout}\n${stderr}`).toBe(0);
  const passed = Number(/(\d+) pass/.exec(`${stdout}\n${stderr}`)?.[1] ?? 0);
  expect(passed, `${stdout}\n${stderr}`).toBeGreaterThanOrEqual(3);
});
