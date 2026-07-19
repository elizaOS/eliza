#!/usr/bin/env node
/** Static coverage contract for the sharded Quality (Fork) typecheck. */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_REPO_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const WORKFLOW_PATH = ".github/workflows/quality-fork.yml";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export function runContract(repoRoot = DEFAULT_REPO_ROOT) {
  const workflow = readFileSync(resolve(repoRoot, WORKFLOW_PATH), "utf8");
  const rootPackage = JSON.parse(
    readFileSync(resolve(repoRoot, "package.json"), "utf8"),
  );
  const workspaces = rootPackage.workspaces ?? [];
  const uncovered = workspaces.filter((pattern) => {
    const normalized = pattern.startsWith("!") ? pattern.slice(1) : pattern;
    return (
      !normalized.startsWith("packages/") && !normalized.startsWith("plugins/")
    );
  });

  assert(
    uncovered.length === 0,
    `package.json: Quality (Fork) typecheck shards do not cover workspace glob(s): ${uncovered.join(", ")}`,
  );
  assert(
    /^\s*typecheck-shards:\s*$/m.test(workflow),
    `${WORKFLOW_PATH}: missing parallel typecheck-shards job`,
  );
  assert(
    /^\s*fail-fast:\s*false\s*$/m.test(workflow),
    `${WORKFLOW_PATH}: typecheck shards must all run to preserve coverage`,
  );
  for (const filter of ["./packages/**", "./plugins/**"]) {
    assert(
      workflow.includes(`filter: ${filter}`),
      `${WORKFLOW_PATH}: missing full-coverage shard filter ${filter}`,
    );
  }
  assert(
    /run:\s*NODE_OPTIONS=.*run-turbo\.mjs run typecheck[^\n]*--filter="\$TYPECHECK_FILTER"/.test(
      workflow,
    ),
    `${WORKFLOW_PATH}: each shard must run the real Turbo typecheck with its matrix filter`,
  );
  assert(
    /^\s*typecheck:\s*$[\s\S]*?^\s*name:\s*Type Check\s*$[\s\S]*?^\s*needs:\s*typecheck-shards\s*$/m.test(
      workflow,
    ),
    `${WORKFLOW_PATH}: required Type Check summary must depend on every shard`,
  );
  assert(
    /SHARD_RESULT:[^\n]*needs\.typecheck-shards\.result[\s\S]*run:\s*test "\$SHARD_RESULT" = success/.test(
      workflow,
    ),
    `${WORKFLOW_PATH}: Type Check summary must fail closed on shard failure`,
  );

  return { workspaces: workspaces.length, filters: 2 };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const result = runContract();
    console.log(
      `quality fork typecheck contract passed (${result.workspaces} workspace globs)`,
    );
  } catch (error) {
    console.error(`[quality-fork-typecheck-contract] FAIL ${error.message}`);
    process.exit(1);
  }
}
