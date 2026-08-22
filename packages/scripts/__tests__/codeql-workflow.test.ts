/**
 * Pins CodeQL to an off-PR scheduled/manual lane and verifies its sharded
 * production coverage, permissions, provisionable runner, category, and
 * immutable-action contracts without executing a scan.
 */
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const workflowText = readFileSync(
  new URL("../../../.github/workflows/codeql.yml", import.meta.url),
  "utf8",
);
type WorkflowStep = {
  env?: Record<string, string>;
  name?: string;
  run?: string;
  shell?: string;
  uses?: string;
  with?: Record<string, unknown>;
};

type Workflow = {
  on?: Record<string, unknown>;
  permissions?: Record<string, string>;
  jobs?: Record<
    string,
    {
      "runs-on"?: string | string[];
      "timeout-minutes"?: number;
      env?: Record<string, string>;
      permissions?: Record<string, string>;
      strategy?: {
        "fail-fast"?: boolean;
        matrix?: {
          include?: Array<{ shard: string; paths: string[] }>;
        };
      };
      steps?: WorkflowStep[];
    }
  >;
};

const workflow = Bun.YAML.parse(workflowText) as Workflow;
const analyze = workflow.jobs?.analyze;
const shards = analyze?.strategy?.matrix?.include ?? [];
const matrixShardExpression = "$" + "{{ matrix.shard }}";
const matrixPathsExpression = "$" + "{{ toJson(matrix.paths) }}";

const expectedIgnores = [
  "**/node_modules/**",
  "**/dist/**",
  "**/build/**",
  "**/.next/**",
  "**/.next-build-*/**",
  "**/.turbo/**",
  "**/coverage/**",
  "**/out/**",
  "**/.venv/**",
  "**/venv/**",
  "**/site-packages/**",
  "**/storybook-static/**",
  "**/dist-mobile/**",
  "**/dist-mobile-ios/**",
  "**/playwright-report/**",
  "**/ios/App/App/public/**",
  "**/android/app/src/main/assets/public/**",
  "**/platforms/android/app/src/main/assets/public/**",
  "**/platforms/*/tmp/**",
  "**/*.min.js",
  "**/__tests__/**",
  "**/__e2e__/**",
  "**/test/**",
  "**/tests/**",
  "**/testing/**",
  "**/test-utils/**",
  "**/fixture/**",
  "**/fixtures/**",
  "**/mocks/**",
  "**/stories/**",
  "**/*.test.ts",
  "**/*.test.tsx",
  "**/*.test.js",
  "**/*.test.jsx",
  "**/*.spec.ts",
  "**/*.spec.tsx",
  "**/*.spec.js",
  "**/*.spec.jsx",
  "**/*.bench.ts",
  "**/*.bench.tsx",
  "**/*.stories.ts",
  "**/*.stories.tsx",
  "**/aesthetic-audit-output-*/**",
  "packages/test/**",
  "packages/app-core/scripts/bun-riscv64/**",
  "packages/scripts/test-console/**",
];

function step(name: string): WorkflowStep {
  const found = analyze?.steps?.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`Missing CodeQL workflow step: ${name}`);
  return found;
}

function renderedConfig(shard: { shard: string; paths: string[] }): {
  name: string;
  paths: string[];
  "paths-ignore": string[];
} {
  const ignoresJson = analyze?.env?.CODEQL_PATHS_IGNORE_JSON;
  if (typeof ignoresJson !== "string") {
    throw new Error("CodeQL job must provide the shared ignore JSON");
  }
  return {
    name: `elizaOS CodeQL ${shard.shard}`,
    paths: shard.paths,
    "paths-ignore": JSON.parse(ignoresJson) as string[],
  };
}

describe("on-demand CodeQL workflow", () => {
  test("never subscribes to pull requests or pushes", () => {
    expect(Object.keys(workflow.on ?? {}).sort()).toEqual([
      "workflow_dispatch",
    ]);
    expect(workflowText).not.toMatch(/^\s+pull_request:/m);
    expect(workflowText).not.toMatch(/^\s+push:/m);
  });

  test("uses the bounded hosted-runner analysis contract", () => {
    expect(analyze?.["runs-on"]).toBe("ubuntu-24.04");
    expect(analyze?.["timeout-minutes"]).toBe(360);
    expect(analyze?.permissions).toEqual({
      contents: "read",
      "security-events": "write",
    });
    expect(workflow.permissions).toEqual({ contents: "read" });
  });

  test("pins aligned CodeQL actions and category-distinct shard uploads", () => {
    const init = step("Initialize CodeQL");
    const analyzeStep = step("Perform CodeQL analysis");
    expect(init.uses).toMatch(/^github\/codeql-action\/init@[0-9a-f]{40}$/);
    expect(analyzeStep.uses).toBe(init.uses?.replace("/init@", "/analyze@"));
    expect(init.with?.languages).toBe("javascript-typescript");
    expect(init.with?.["build-mode"]).toBe("none");
    expect(init.with?.["config-file"]).toBe(
      "./.github/codeql-generated-config.yml",
    );
    expect(init.with).not.toHaveProperty("config");
    expect(init.with).not.toHaveProperty("ram");
    expect(init.with).not.toHaveProperty("threads");
    expect(analyzeStep.with?.category).toBe(
      `/language:javascript-typescript/shard:${matrixShardExpression}`,
    );
  });

  test("runs seven independent shards without fail-fast cancellation", () => {
    expect(analyze?.strategy?.["fail-fast"]).toBe(false);
    expect(shards.map(({ shard }) => shard).sort()).toEqual([
      "cloud",
      "platform-ops",
      "plugins-a-f",
      "plugins-g-n",
      "plugins-o-z",
      "product",
      "runtime",
    ]);
  });

  test("assigns every maintained package and plugin root exactly once", () => {
    const allPaths = shards.flatMap(({ paths }) => paths);
    expect(new Set(allPaths).size).toBe(allPaths.length);

    const excludedPackageRoots = new Set([
      "benchmarks",
      "docs",
      "examples",
      "test",
    ]);
    const maintainedPackages = readdirSync(
      new URL("../../../packages", import.meta.url),
      { withFileTypes: true },
    )
      .filter(
        (entry) => entry.isDirectory() && !excludedPackageRoots.has(entry.name),
      )
      .map(({ name }) => `packages/${name}/**`)
      .sort();
    const maintainedPlugins = readdirSync(
      new URL("../../../plugins", import.meta.url),
      { withFileTypes: true },
    )
      .filter(
        (entry) => entry.isDirectory() && entry.name.startsWith("plugin-"),
      )
      .map(({ name }) => `plugins/${name}/**`)
      .sort();

    expect(
      allPaths.filter((path) => path.startsWith("packages/")).sort(),
    ).toEqual(maintainedPackages);
    expect(
      allPaths.filter((path) => /^plugins\/[^*]+\/\*\*$/.test(path)).sort(),
    ).toEqual(maintainedPlugins);
    expect(allPaths.filter((path) => path.includes("*"))).toEqual(
      expect.arrayContaining(["plugins/*.ts", "scripts/**"]),
    );
  });

  test("renders each shard with only the reviewed non-shipping exclusions", () => {
    const writer = step("Write shard CodeQL configuration");
    expect(writer.shell).toBe("bash");
    expect(writer.env).toEqual({
      CODEQL_SHARD: matrixShardExpression,
      CODEQL_PATHS_JSON: matrixPathsExpression,
    });
    expect(writer.run).toContain(
      "paths: JSON.parse(process.env.CODEQL_PATHS_JSON)",
    );
    expect(writer.run).toContain(
      '"paths-ignore": JSON.parse(process.env.CODEQL_PATHS_IGNORE_JSON)',
    );
    expect(writer.run).toContain(
      'writeFileSync(\n  ".github/codeql-generated-config.yml"',
    );
    for (const shard of shards) {
      const config = renderedConfig(shard);
      expect(config.name).toBe(`elizaOS CodeQL ${shard.shard}`);
      expect(config.paths).toEqual(shard.paths);
      expect(config["paths-ignore"]).toEqual(expectedIgnores);
    }
    expect(expectedIgnores).not.toContain("packages/homepage/**");
  });
});
