/**
 * Regression test for #17778 — every root under `packages/agent` that can hold
 * a `*.integration.test.ts` suite must be reachable by a pattern in the shared
 * integration lane.
 *
 * The agent package's own lanes exclude the `.integration.test.` suffix
 * (`packages/agent/vitest.config.ts` and `scripts/run-vitest-batches.mjs`), so
 * `packages/scripts/vitest/integration.config.ts` is the only lane that can run
 * those files. Its include list carried `packages/agent/test/**` but not
 * `packages/agent/src/**`, so a src-level suite was excluded from the package
 * lanes and included nowhere — it ran in no lane at all, silently. The lane's
 * own comments record the same class of failure twice before, for
 * `plugins/*` test/ and src/ roots.
 *
 * These assertions are on the config's include list rather than on a glob
 * engine so the test states the invariant directly: discovery is by pattern,
 * and both agent roots are covered.
 */
import { readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import integrationConfig from "../vitest/integration.config.ts";

const AGENT_INTEGRATION_ROOTS = ["src", "test"] as const;
const INTEGRATION_SUFFIX = ".integration.test.ts";

function includeGlobs(): string[] {
  const include = integrationConfig.test?.include;
  if (!Array.isArray(include)) {
    throw new Error(
      "integration.config.ts must declare test.include as an array",
    );
  }
  return include;
}

/** Every file under `dir` whose name ends with the integration suffix. */
function findIntegrationSuites(dir: string, acc: string[] = []): string[] {
  let entries: ReturnType<typeof readdirSync>;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      findIntegrationSuites(full, acc);
    } else if (entry.name.endsWith(INTEGRATION_SUFFIX)) {
      acc.push(full);
    }
  }
  return acc;
}

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const agentRoot = path.join(repoRoot, "packages", "agent");

describe("integration lane covers packages/agent by pattern", () => {
  for (const root of AGENT_INTEGRATION_ROOTS) {
    it(`includes packages/agent/${root} by glob`, () => {
      const expected = `packages/agent/${root}/**/*${INTEGRATION_SUFFIX}`;
      expect(includeGlobs().some((glob) => glob.endsWith(expected))).toBe(true);
    });
  }

  it("has no agent integration suite outside a covered root", () => {
    const covered = AGENT_INTEGRATION_ROOTS.map(
      (root) => path.join(agentRoot, root) + path.sep,
    );
    const uncovered = findIntegrationSuites(agentRoot)
      .filter((file) => !covered.some((prefix) => file.startsWith(prefix)))
      .map((file) => path.relative(repoRoot, file).split(path.sep).join("/"));

    // A suite under a third root would be excluded from the agent lanes and
    // matched by no include glob — the exact shape of #17778. Add the root to
    // the integration config's include list and to AGENT_INTEGRATION_ROOTS.
    expect(uncovered).toEqual([]);
  });
});
