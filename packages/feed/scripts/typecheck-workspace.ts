#!/usr/bin/env bun

import { spawn } from "node:child_process";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");

const WORKSPACES = [
  "packages/shared",
  "packages/db",
  "packages/core",
  "packages/pack-default",
  "packages/api",
  "packages/a2a",
  "packages/mcp",
  "packages/engine",
  "packages/training",
  "packages/agents",
  "packages/testing",
  "packages/sim",
  "packages/examples/local-a2a-server",
  "packages/examples/feed-typescript-agent",
  "apps/cli",
  "apps/mobile",
  "apps/web",
] as const;

const TYPECHECK_PROJECTS: Partial<Record<(typeof WORKSPACES)[number], string>> =
  {
    "apps/mobile": "apps/mobile/tsconfig.typecheck.json",
    "apps/web": "apps/web/tsconfig.typecheck.json",
    "packages/testing": "packages/testing/tsconfig.typecheck.json",
  };

const selectedWorkspaces =
  process.argv.length > 2 ? process.argv.slice(2) : [...WORKSPACES];
const needsAgentDeclarations = selectedWorkspaces.some((workspace) =>
  ["packages/api", "packages/agents", "apps/cli", "apps/web"].includes(
    workspace,
  ),
);
const needsApiDeclarations = selectedWorkspaces.some((workspace) =>
  [
    "packages/a2a",
    "packages/mcp",
    "apps/cli",
    "apps/web",
    "packages/testing",
  ].includes(workspace),
);
const needsA2aDeclarations = selectedWorkspaces.some(
  (workspace) =>
    workspace === "packages/mcp" ||
    workspace === "apps/cli" ||
    workspace === "apps/web" ||
    workspace === "packages/testing",
);
const needsCliDeclarationDependencies = selectedWorkspaces.some(
  (workspace) =>
    workspace === "apps/cli" ||
    workspace === "apps/web" ||
    workspace === "packages/testing",
);

async function runTypecheck(workspace: string): Promise<void> {
  process.stdout.write(`\n[${workspace}] typecheck\n`);
  const project =
    workspace in TYPECHECK_PROJECTS
      ? TYPECHECK_PROJECTS[workspace as (typeof WORKSPACES)[number]]
      : workspace;

  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn("bun", ["run", "tsc", "-p", project, "--noEmit"], {
      cwd: ROOT,
      stdio: "inherit",
      env: process.env,
    });

    child.on("error", rejectPromise);
    child.on("exit", (code) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      rejectPromise(
        new Error(`${workspace} typecheck failed with code ${code ?? "null"}`),
      );
    });
  });
}

// Bootstrap agents declarations to break circular dependency with api.
// api resolves @feed/agents/* from agents/dist, but agents references api
// via project refs. Emit agents .d.ts without type-checking so api can resolve
// its imports before the full typecheck sequence runs.
if (needsAgentDeclarations) {
  process.stdout.write(
    "\n[packages/agents] emitting declarations (bootstrap)\n",
  );
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn(
      "bun",
      [
        "run",
        "tsc",
        "-p",
        "packages/agents",
        "--emitDeclarationOnly",
        "--noCheck",
      ],
      { cwd: ROOT, stdio: "inherit", env: process.env },
    );
    child.on("error", rejectPromise);
    child.on("exit", (code) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      rejectPromise(
        new Error(
          `agents declaration bootstrap failed with code ${code ?? "null"}`,
        ),
      );
    });
  });
}

// Bootstrap API declarations for packages that intentionally consume @feed/api
// through package declarations instead of pulling the full API source tree under
// their own rootDir.
if (needsApiDeclarations) {
  process.stdout.write("\n[packages/api] emitting declarations (bootstrap)\n");
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn(
      "bun",
      [
        "run",
        "tsc",
        "-p",
        "packages/api",
        "--emitDeclarationOnly",
        "--noCheck",
      ],
      { cwd: ROOT, stdio: "inherit", env: process.env },
    );
    child.on("error", rejectPromise);
    child.on("exit", (code) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      rejectPromise(
        new Error(
          `api declaration bootstrap failed with code ${code ?? "null"}`,
        ),
      );
    });
  });
}

if (needsA2aDeclarations) {
  process.stdout.write("\n[packages/a2a] emitting declarations (bootstrap)\n");
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn(
      "bun",
      [
        "run",
        "tsc",
        "-p",
        "packages/a2a",
        "--emitDeclarationOnly",
        "--noCheck",
      ],
      { cwd: ROOT, stdio: "inherit", env: process.env },
    );
    child.on("error", rejectPromise);
    child.on("exit", (code) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      rejectPromise(
        new Error(
          `a2a declaration bootstrap failed with code ${code ?? "null"}`,
        ),
      );
    });
  });
}

if (needsCliDeclarationDependencies) {
  for (const workspace of [
    "packages/shared",
    "packages/db",
    "packages/core",
    "packages/engine",
    "packages/pack-default",
    "packages/mcp",
  ]) {
    process.stdout.write(
      `\n[${workspace}] emitting declarations (bootstrap)\n`,
    );
    await new Promise<void>((resolvePromise, rejectPromise) => {
      const child = spawn(
        "bun",
        ["run", "tsc", "-p", workspace, "--emitDeclarationOnly", "--noCheck"],
        { cwd: ROOT, stdio: "inherit", env: process.env },
      );
      child.on("error", rejectPromise);
      child.on("exit", (code) => {
        if (code === 0) {
          resolvePromise();
          return;
        }
        rejectPromise(
          new Error(
            `${workspace} declaration bootstrap failed with code ${code ?? "null"}`,
          ),
        );
      });
    });
  }
}

for (const workspace of selectedWorkspaces) {
  await runTypecheck(workspace);
}

process.stdout.write("\nAll workspace typechecks passed.\n");
