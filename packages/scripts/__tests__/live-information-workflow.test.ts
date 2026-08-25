/** Verifies the manual live-information workflow fails before setup when exact planner or independent-judge credentials are absent. */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { spawnSync } from "../lib/spawn-sync-captured.mjs";

const repoRoot = new URL("../../../", import.meta.url);
const workflow = Bun.YAML.parse(
  readFileSync(new URL(".github/workflows/live-smoke.yml", repoRoot), "utf8"),
) as {
  jobs?: {
    smoke?: {
      steps?: Array<{
        env?: Record<string, string>;
        name?: string;
        run?: string;
        uses?: string;
      }>;
    };
  };
};

function credentialStep() {
  const steps = workflow.jobs?.smoke?.steps ?? [];
  const step = steps.find(
    (candidate) =>
      candidate.name === "Require exact live information credentials",
  );
  if (!step?.run)
    throw new Error("Missing live-information credential preflight");
  return { step, steps };
}

function runPreflight(
  plannerProvider: "openai" | "anthropic" | "openrouter",
  env: Record<string, string>,
) {
  return spawnSync("bash", ["-c", credentialStep().step.run ?? ""], {
    encoding: "utf8",
    env: {
      ...process.env,
      OPENAI_API_KEY: "",
      ANTHROPIC_API_KEY: "",
      OPENROUTER_API_KEY: "",
      CEREBRAS_API_KEY: "judge-key",
      EVAL_CEREBRAS_API_KEY: "",
      PLANNER_PROVIDER: plannerProvider,
      ...env,
    },
  });
}

describe("Live Smoke live-information credential boundary", () => {
  test("runs before workspace setup", () => {
    const { step, steps } = credentialStep();
    const preflightIndex = steps.indexOf(step);
    const setupIndex = steps.findIndex(
      (candidate) => candidate.uses === "./.github/actions/setup-bun-workspace",
    );

    expect(preflightIndex).toBeGreaterThanOrEqual(0);
    expect(setupIndex).toBeGreaterThan(preflightIndex);
    expect(step.env?.PLANNER_PROVIDER).toBe(
      "$" + "{{ inputs.planner_provider }}",
    );
  });

  test.each([
    ["openai", "OPENAI_API_KEY"],
    ["anthropic", "ANTHROPIC_API_KEY"],
    ["openrouter", "OPENROUTER_API_KEY"],
  ] as const)(
    "requires the exact %s planner credential instead of a compatible key",
    (provider, key) => {
      for (const value of ["", " \t\n"]) {
        const rejected = runPreflight(provider, { [key]: value });
        expect(rejected.status).toBe(1);
        expect(rejected.stdout).toContain(
          "selected live-information planner credential is missing or blank",
        );
      }

      expect(runPreflight(provider, { [key]: "planner-key" }).status).toBe(0);
    },
  );

  test("requires the independent judge credential separately", () => {
    const rejected = runPreflight("openai", {
      OPENAI_API_KEY: "planner-key",
      CEREBRAS_API_KEY: " \t\n",
    });

    expect(rejected.status).toBe(1);
    expect(rejected.stdout).toContain(
      "independent Cerebras judge credential is missing or blank",
    );
  });
});
