/** Exercises the package-owned Railway bundle boundary without contacting Railway. */

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const deployScript = readFileSync(
  `${import.meta.dir}/../scripts/deploy-railway.sh`,
  "utf8",
);

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

test("the staged Railway image uses the verified shared Opus selector", () => {
  expect(deployScript).toContain('"@discordjs/opus": "0.10.0"');
  expect(deployScript).toContain(
    'cp "$HERE/scripts/select-opus-prebuild.ts" "$STAGE/select-opus-prebuild.ts"',
  );
  expect(deployScript).toContain(
    'npm_config_target="$' +
      '{OPUS_PREBUILD_NODE_TARGET}" bun install --production',
  );
  expect(deployScript).toContain(
    'bun ./select-opus-prebuild.ts . "$' + '{TARGETARCH}"',
  );
  expect(deployScript).toContain(
    '--platform "$GATEWAY_DISCORD_BUILD_PLATFORM"',
  );
  expect(deployScript).toContain('--tag "$GATEWAY_DISCORD_BUILD_TAG"');
});
