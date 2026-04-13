#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const pluginsRoot = path.join(repoRoot, "plugins");
const SCRIPT_CANDIDATES = ["publish:next", "release:next:strict"];

function readPackageJson(packageDir) {
  try {
    return JSON.parse(
      readFileSync(path.join(packageDir, "package.json"), "utf8"),
    );
  } catch {
    return null;
  }
}

function runCommand(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: "inherit",
    });

    child.on("error", (error) => {
      reject(
        new Error(
          `${command} ${args.join(" ")} failed: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    });

    child.on("exit", (code, signal) => {
      if (signal) {
        reject(
          new Error(
            `${command} ${args.join(" ")} exited due to signal ${signal}`,
          ),
        );
        return;
      }

      if ((code ?? 1) !== 0) {
        reject(
          new Error(
            `${command} ${args.join(" ")} exited with code ${code ?? 1}`,
          ),
        );
        return;
      }

      resolve();
    });
  });
}

function discoverPluginRoots() {
  if (!existsSync(pluginsRoot)) {
    return [];
  }

  return readdirSync(pluginsRoot, { withFileTypes: true })
    .filter(
      (entry) =>
        (entry.isDirectory() || entry.isSymbolicLink()) &&
        /^(app|plugin)-/.test(entry.name),
    )
    .map((entry) => path.join(pluginsRoot, entry.name))
    .filter((packageDir) => existsSync(path.join(packageDir, "package.json")))
    .sort();
}

async function main() {
  const pluginRoots = discoverPluginRoots();
  if (pluginRoots.length === 0) {
    console.log(
      "[publish-local-plugins-next] No repo-local plugin worktrees found",
    );
    return;
  }

  let ran = 0;
  for (const pluginRoot of pluginRoots) {
    const packageJson = readPackageJson(pluginRoot);
    const scriptName = SCRIPT_CANDIDATES.find((candidate) =>
      Boolean(packageJson?.scripts?.[candidate]),
    );

    if (!scriptName) {
      console.log(
        `[publish-local-plugins-next] Skipping ${path.basename(pluginRoot)} (no ${SCRIPT_CANDIDATES.join(" / ")})`,
      );
      continue;
    }

    console.log(
      `[publish-local-plugins-next] Running bun run ${scriptName} in ${pluginRoot}`,
    );
    await runCommand("bun", ["run", scriptName], pluginRoot);
    ran += 1;
  }

  if (ran === 0) {
    console.log(
      "[publish-local-plugins-next] No plugin worktree exposed a publish/release script",
    );
  }
}

main().catch((error) => {
  console.error(
    `[publish-local-plugins-next] ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
});
