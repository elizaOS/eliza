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
  name?: string;
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
  const template = step("Initialize CodeQL").with?.config;
  if (typeof template !== "string") {
    throw new Error("Initialize CodeQL must provide an inline config");
  }
  return Bun.YAML.parse(
    template
      .replaceAll(matrixShardExpression, shard.shard)
      .replace(matrixPathsExpression, JSON.stringify(shard.paths)),
  ) as {
    name: string;
    paths: string[];
    "paths-ignore": string[];
  };
}

describe("scheduled CodeQL workflow", () => {
  test("never subscribes to pull requests or pushes", () => {
    expect(Object.keys(workflow.on ?? {}).sort()).toEqual([
      "schedule",
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
    expect(init.with?.config).toBeTypeOf("string");
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
      .filter((entry) => entry.isDirectory())
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
    for (const shard of shards) {
      const config = renderedConfig(shard);
      expect(config.name).toBe(`elizaOS CodeQL ${shard.shard}`);
      expect(config.paths).toEqual(shard.paths);
      expect(config["paths-ignore"]).toEqual(expectedIgnores);
    }
    expect(expectedIgnores).not.toContain("packages/homepage/**");
  });
});
