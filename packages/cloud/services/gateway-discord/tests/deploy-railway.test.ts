/** Exercises the package-owned Railway bundle boundary without contacting Railway. */

import { expect, test } from "bun:test";

test("the Railway deploy script builds the source-form workspace bundle", async () => {
  const process = Bun.spawn(
    ["bash", "scripts/deploy-railway.sh", "--build-only"],
    {
      cwd: `${import.meta.dir}/..`,
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);

  if (exitCode !== 0) {
    throw new Error(`Railway bundle proof failed:\n${stderr}`);
  }
  expect(stdout).toContain("[deploy] build-only proof passed");
});

test("the Railway deploy script rejects unknown modes before building", async () => {
  const process = Bun.spawn(
    ["bash", "scripts/deploy-railway.sh", "--unexpected"],
    {
      cwd: `${import.meta.dir}/..`,
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [exitCode, stderr] = await Promise.all([
    process.exited,
    new Response(process.stderr).text(),
  ]);

  expect(exitCode).toBe(2);
  expect(stderr).toContain("usage:");
});
