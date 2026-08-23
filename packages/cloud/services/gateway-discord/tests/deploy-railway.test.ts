/** Exercises the package-owned Railway bundle boundary without contacting Railway. */

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const packageRoot = `${import.meta.dir}/..`;

test("the Railway deploy script builds the source-form workspace bundle", async () => {
  const process = Bun.spawn(
    ["bash", "scripts/deploy-railway.sh", "--build-only"],
    {
      cwd: packageRoot,
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
      cwd: packageRoot,
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

test("the Railway image uses the same attested Opus installer as the repository image", () => {
  const dockerfile = readFileSync(
    `${packageRoot}/scripts/Railway.Dockerfile`,
    "utf8",
  );
  const runtimeManifest = JSON.parse(
    readFileSync(`${packageRoot}/scripts/railway-runtime-package.json`, "utf8"),
  );
  const deployScript = readFileSync(
    `${packageRoot}/scripts/deploy-railway.sh`,
    "utf8",
  );

  expect(runtimeManifest.dependencies["@discordjs/opus"]).toBe("0.10.0");
  expect(runtimeManifest.trustedDependencies).toContain("@discordjs/opus");
  expect(dockerfile).toContain(
    "COPY package.json install-portable-opus.mjs ./",
  );
  expect(dockerfile).toContain("RUN bun ./install-portable-opus.mjs /app /app");
  expect(dockerfile).toContain(
    "RUN bun /usr/local/lib/install-portable-opus.mjs --smoke-only /app",
  );
  expect(dockerfile).not.toContain("RUN bun install --production");
  expect(deployScript).toContain(
    'cp "$HERE/scripts/install-portable-opus.mjs" "$STAGE/install-portable-opus.mjs"',
  );
  expect(deployScript).toContain("--docker-build-only");
});
