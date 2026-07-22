#!/usr/bin/env bun

/**
 * Typecheck orchestrator for Feed workspace packages.
 * It runs package-specific TypeScript projects in dependency order and builds declarations needed by downstream apps.
 */

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

export function selectFeedWorkspaces(argv = process.argv): string[] {
  return argv.length > 2 ? argv.slice(2) : [...WORKSPACES];
}

export function feedTypecheckPlan(selectedWorkspaces: readonly string[]) {
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
  return {
    selectedWorkspaces: [...selectedWorkspaces],
    needsAgentDeclarations,
    needsApiDeclarations,
    needsA2aDeclarations,
    needsCliDeclarationDependencies,
  };
}

export async function runTypecheck(workspace: string): Promise<void> {
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

export async function emitFeedDeclarations(
  workspace: string,
  label = workspace,
): Promise<void> {
  process.stdout.write(`\n[${label}] emitting declarations (bootstrap)\n`);
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn(
      "bun",
      ["run", "tsc6", "-p", workspace, "--emitDeclarationOnly", "--noCheck"],
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
          `${label} declaration bootstrap failed with code ${code ?? "null"}`,
        ),
      );
    });
  });
}

export async function typecheckFeedWorkspace(
  argv = process.argv,
  options: {
    runTypecheck?: typeof runTypecheck;
    emitDeclarations?: typeof emitFeedDeclarations;
  } = {},
): Promise<void> {
  const plan = feedTypecheckPlan(selectFeedWorkspaces(argv));
  const checkWorkspace = options.runTypecheck ?? runTypecheck;
  const emitDeclarations = options.emitDeclarations ?? emitFeedDeclarations;

  // Bootstrap agents declarations to break circular dependency with api.
  // api resolves @feed/agents/* from agents/dist, but agents references api
  // via project refs. Emit agents .d.ts without type-checking so api can resolve
  // its imports before the full typecheck sequence runs.
  if (plan.needsAgentDeclarations) {
    await emitDeclarations("packages/agents", "packages/agents");
  }

  // Bootstrap API declarations for packages that intentionally consume @feed/api
  // through package declarations instead of pulling the full API source tree under
  // their own rootDir.
  if (plan.needsApiDeclarations) {
    await emitDeclarations("packages/api", "packages/api");
  }

  if (plan.needsA2aDeclarations) {
    await emitDeclarations("packages/a2a", "packages/a2a");
  }

  if (plan.needsCliDeclarationDependencies) {
    for (const workspace of [
      "packages/shared",
      "packages/db",
      "packages/core",
      "packages/engine",
      "packages/pack-default",
      "packages/mcp",
    ]) {
      await emitDeclarations(workspace);
    }
  }

  for (const workspace of plan.selectedWorkspaces) {
    await checkWorkspace(workspace);
  }

  process.stdout.write("\nAll workspace typechecks passed.\n");
}

if (import.meta.main) {
  await typecheckFeedWorkspace();
}
