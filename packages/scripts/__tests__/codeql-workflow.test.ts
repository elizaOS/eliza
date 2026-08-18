/**
 * Pins CodeQL to an off-PR scheduled/manual lane and verifies its extraction,
 * permissions, provisionable runner, and immutable-action contracts without
 * executing a scan.
 */
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const workflowText = readFileSync(
  new URL("../../../.github/workflows/codeql.yml", import.meta.url),
  "utf8",
);
const configText = readFileSync(
  new URL("../../../.github/codeql/codeql-config.yml", import.meta.url),
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
      steps?: WorkflowStep[];
    }
  >;
};

const workflow = Bun.YAML.parse(workflowText) as Workflow;
const analyze = workflow.jobs?.analyze;

function step(name: string): WorkflowStep {
  const found = analyze?.steps?.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`Missing CodeQL workflow step: ${name}`);
  return found;
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
      actions: "read",
      contents: "read",
      "security-events": "write",
    });
    expect(workflow.permissions).toEqual({ contents: "read" });
  });

  test("pins aligned CodeQL actions and the extraction config", () => {
    const init = step("Initialize CodeQL");
    const analyzeStep = step("Perform CodeQL analysis");
    expect(init.uses).toMatch(/^github\/codeql-action\/init@[0-9a-f]{40}$/);
    expect(analyzeStep.uses).toBe(init.uses?.replace("/init@", "/analyze@"));
    expect(init.with?.languages).toBe("javascript-typescript");
    expect(init.with?.["build-mode"]).toBe("none");
    expect(init.with?.["config-file"]).toBe(
      "./.github/codeql/codeql-config.yml",
    );
    expect(init.with).not.toHaveProperty("ram");
    expect(init.with).not.toHaveProperty("threads");
  });

  test("excludes generated dependency and build trees at extraction time", () => {
    const config = Bun.YAML.parse(configText) as {
      "paths-ignore"?: string[];
    };
    expect(config["paths-ignore"]).toEqual(
      expect.arrayContaining([
        "**/node_modules/**",
        "**/dist/**",
        "**/build/**",
        "**/.next/**",
        "packages/app-core/scripts/bun-riscv64/**",
      ]),
    );
  });

  test("scans production code instead of non-shipping test and fixture trees", () => {
    const config = Bun.YAML.parse(configText) as {
      "paths-ignore"?: string[];
    };
    expect(config["paths-ignore"]).toEqual(
      expect.arrayContaining([
        "**/__tests__/**",
        "**/test/**",
        "**/tests/**",
        "**/fixtures/**",
        "**/mocks/**",
        "**/*.test.ts",
        "**/*.test.tsx",
        "**/*.spec.ts",
        "**/*.spec.tsx",
        "packages/test/**",
      ]),
    );
    expect(config["paths-ignore"]).not.toContain("packages/homepage/**");
  });
});
