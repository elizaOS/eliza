/**
 * Builds and installs the publishable agent tarball into an isolated consumer,
 * then starts its API route kernel without binding TCP. This catches missing
 * exports, undeclared runtime dependencies, and source-only resolution leaks.
 */
import { spawnSync } from "node:child_process";
import {
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const repositoryRoot = path.resolve(packageRoot, "../..");
const smokeRoot = await realpath(
  await mkdtemp(path.join(tmpdir(), "eliza-agent-consumer-")),
);

async function readManifest(directory) {
  return JSON.parse(
    await readFile(path.join(directory, "package.json"), "utf8"),
  );
}

async function resolveWorkspaceDependencyClosure(rootManifest) {
  const resolved = new Map();
  const pending = Object.keys(rootManifest.dependencies ?? {}).filter((name) =>
    name.startsWith("@elizaos/"),
  );

  while (pending.length > 0) {
    const name = pending.pop();
    if (!name || resolved.has(name)) continue;
    if (name === rootManifest.name) continue;
    const installedPath = path.join(
      repositoryRoot,
      "node_modules",
      ...name.split("/"),
    );
    let workspacePath;
    try {
      workspacePath = await realpath(installedPath);
    } catch (error) {
      throw new Error(`Workspace dependency ${name} is not installed`, {
        cause: error,
      });
    }
    const manifest = await readManifest(workspacePath);
    if (manifest.name !== name) {
      throw new Error(
        `Workspace dependency ${name} resolved to unexpected package ${String(manifest.name)}`,
      );
    }
    const tarball = path.join(
      smokeRoot,
      `${name.replaceAll(/[/@]/g, "_")}.tgz`,
    );
    run(
      "bun",
      ["pm", "pack", "--ignore-scripts", "--filename", tarball, "--quiet"],
      workspacePath,
    );
    resolved.set(name, `file:${tarball}`);
    for (const dependency of Object.keys(manifest.dependencies ?? {})) {
      if (dependency.startsWith("@elizaos/") && !resolved.has(dependency)) {
        pending.push(dependency);
      }
    }
  }

  return Object.fromEntries(
    [...resolved.entries()].sort(([a], [b]) => a.localeCompare(b)),
  );
}

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
  const tarball = (await readdir(smokeRoot)).find((name) =>
    name.endsWith(".tgz"),
  );
  if (!tarball) throw new Error("npm pack did not produce an agent tarball");

  const distManifest = await readManifest(path.join(packageRoot, "dist"));
  const workspaceDependencies =
    await resolveWorkspaceDependencyClosure(distManifest);
  await writeFile(
    path.join(smokeRoot, "package.json"),
    JSON.stringify({
      private: true,
      type: "module",
      dependencies: {
        ...workspaceDependencies,
        "@elizaos/agent": `file:${path.join(smokeRoot, tarball)}`,
      },
      overrides: {
        ...workspaceDependencies,
        "@elizaos/agent": `file:${path.join(smokeRoot, tarball)}`,
      },
    }),
  );
  run(
    "npm",
    ["install", "--ignore-scripts", "--omit=optional", "--legacy-peer-deps"],
    smokeRoot,
  );
  for (const name of [
    distManifest.name,
    ...Object.keys(workspaceDependencies),
  ]) {
    const installed = await realpath(
      path.join(smokeRoot, "node_modules", ...name.split("/")),
    );
    if (!installed.startsWith(`${smokeRoot}${path.sep}`)) {
      throw new Error(
        `Packed dependency ${name} escapes the isolated consumer: ${installed}`,
      );
    }
  }
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
    NODE_OPTIONS: "",
    NODE_PATH: "",
    ELIZA_STATE_DIR: path.join(smokeRoot, "state"),
  });
  process.stdout.write("isolated package install/start smoke passed\n");
} catch (error) {
  // error-policy:J1 executable boundary translates build/install/start failure.
  process.stderr.write(
    `${error instanceof Error ? error.stack : String(error)}\n`,
  );
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
