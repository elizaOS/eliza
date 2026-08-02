/**
 * Builds and installs the publishable agent tarball into an isolated consumer,
 * then starts its API route kernel without binding TCP. This catches missing
 * exports, undeclared runtime dependencies, and source-only resolution leaks.
 */
import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const smokeRoot = await mkdtemp(path.join(packageRoot, ".isolated-smoke-"));

function run(command, args, cwd, env = process.env) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    stdio: "pipe",
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed\n${result.stdout}\n${result.stderr}`,
    );
  }
  return result.stdout.trim();
}

try {
  run("bun", ["run", "build:dist"], packageRoot);
  run("npm", ["pack", "./dist", "--pack-destination", smokeRoot], packageRoot);
  const tarball = (await readdir(smokeRoot)).find((name) => name.endsWith(".tgz"));
  if (!tarball) throw new Error("npm pack did not produce an agent tarball");

  await writeFile(
    path.join(smokeRoot, "package.json"),
    JSON.stringify({ private: true, type: "module" }),
  );
  run(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--omit=optional",
      "--legacy-peer-deps",
      path.join(smokeRoot, tarball),
    ],
    smokeRoot,
  );
  await writeFile(
    path.join(smokeRoot, "smoke.mjs"),
    `import { startApiServer } from "@elizaos/agent/api/server";
const server = await startApiServer({ skipListen: true, skipDeferredStartupWork: true });
if (!Number.isInteger(server.port)) throw new Error("invalid API port contract");
await server.close();
console.log("isolated agent API startup passed");
`,
  );
  run("node", [path.join(smokeRoot, "smoke.mjs")], smokeRoot, {
    ...process.env,
    ELIZA_STATE_DIR: path.join(smokeRoot, "state"),
  });
  process.stdout.write("isolated package install/start smoke passed\n");
} catch (error) {
  // error-policy:J1 executable boundary translates build/install/start failure.
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
} finally {
  try {
    await rm(smokeRoot, { recursive: true, force: true });
  } catch (error) {
    // error-policy:J6 the primary smoke result remains authoritative; cleanup
    // failure is visible and the directory is scoped under this package.
    process.stderr.write(`isolated smoke cleanup failed: ${String(error)}\n`);
    process.exitCode = 1;
  }
}
