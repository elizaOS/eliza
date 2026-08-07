/**
 * Agent + integration-config guards:
 * - knowledge-graph subpath resolves to source without a prebuilt agent dist
 * - packages/agent src/ and test/ roots are both covered by integration globs
 *   (#17778 / #17838 — agent package lanes exclude *.integration.test.*)
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import integrationConfig from "../vitest/integration.config.ts";

interface AliasEntry {
  find: string | RegExp;
  replacement: string;
}

function matches(find: string | RegExp, importee: string): boolean {
  if (find instanceof RegExp) return find.test(importee);
  return importee === find || importee.startsWith(`${find}/`);
}

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

describe("integration.config.ts agent directory export", () => {
  it("resolves the knowledge-graph subpath to its source index", () => {
    const aliases = (integrationConfig as { resolve?: { alias?: unknown } })
      .resolve?.alias;
    expect(Array.isArray(aliases)).toBe(true);

    const specifier = "@elizaos/agent/services/knowledge-graph";
    const entry = (aliases as AliasEntry[]).find(({ find }) =>
      matches(find, specifier),
    );
    const resolved = entry
      ? specifier.replace(entry.find, entry.replacement)
      : undefined;

    expect(resolved).toBeDefined();
    expect(
      existsSync(resolved as string) && statSync(resolved as string).isFile(),
    ).toBe(true);
    expect((resolved as string).replace(/\\/g, "/")).toMatch(
      /packages\/agent\/src\/services\/knowledge-graph\/index\.ts$/,
    );
  });
});

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
    // matched by no include glob — the exact shape of #17778.
    expect(uncovered).toEqual([]);
  });

  it("discovers at least one packages/agent src integration suite", () => {
    // Non-vacuous: the renamed views-registry.integration.test.ts must match.
    const srcSuites = findIntegrationSuites(path.join(agentRoot, "src")).map(
      (file) => path.relative(repoRoot, file).split(path.sep).join("/"),
    );
    expect(srcSuites.length).toBeGreaterThan(0);
    expect(
      srcSuites.some((file) =>
        file.endsWith("views-registry.integration.test.ts"),
      ),
    ).toBe(true);
  });
});
