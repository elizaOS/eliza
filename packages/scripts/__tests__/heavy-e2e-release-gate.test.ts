/**
 * Fail-closed contract for the release heavy E2E gate (issue behind PR #20094).
 *
 * The two heavy browser suites self-skip via `describeIf` unless
 * ELIZA_LIVE_TEST=1, a real Chrome binary, and a live provider key are all
 * present, and a fully skipped vitest run exits 0. These tests pin the three
 * layers that keep that from reading as release-gate green: the root
 * `test:e2e:heavy` script must route through run-heavy-e2e.mjs, the
 * release-electrobun.yml heavy step must provision the live env, and the
 * launcher itself must reject missing prerequisites and skipped-out runs.
 * The launcher subprocess checks drive the real production entrypoint.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "../lib/spawn-sync-captured.mjs";
import {
  assertExecutedHeavyRun,
  DEFAULT_CHROME_PATH,
  evaluateHeavyPreflight,
  extractForwardedTestFiles,
  LIVE_PROVIDER_KEY_ENV_VARS,
} from "../run-heavy-e2e.mjs";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

function read(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), "utf8");
}

interface WorkflowStep {
  env?: Record<string, string>;
  id?: string;
  name?: string;
  run?: string;
  "continue-on-error"?: unknown;
}

interface Workflow {
  jobs?: Record<string, { steps?: WorkflowStep[] }>;
}

const HEAVY_SUITE_FILES = [
  "./test/app/memory-relationships.real.e2e.test.ts",
  "./test/app/qa-checklist.real.e2e.test.ts",
];

describe("root test:e2e:heavy script", () => {
  const scripts = JSON.parse(read("package.json")).scripts as Record<
    string,
    string
  >;
  const heavy = scripts["test:e2e:heavy"] ?? "";

  test("routes through the fail-closed launcher, not bare vitest", () => {
    expect(heavy).toContain("node ../scripts/run-heavy-e2e.mjs");
    expect(heavy).not.toContain("vitest run");
    expect(heavy).not.toContain("bunx vitest");
  });

  test("never reintroduces skip-as-success flags", () => {
    expect(heavy).not.toContain("--passWithNoTests");
  });

  test("still names the config and both release-gated suites for the matrix validator", () => {
    expect(heavy).toStartWith("cd packages/app-core && ");
    expect(heavy).toContain("--config vitest.app-real-e2e.config.ts");
    for (const file of HEAVY_SUITE_FILES) {
      expect(heavy).toContain(file);
    }
  });
});

describe("release-electrobun.yml heavy E2E step", () => {
  const workflow = Bun.YAML.parse(
    read(".github/workflows/release-electrobun.yml"),
  ) as Workflow;
  const steps = workflow.jobs?.["validate-release"]?.steps ?? [];
  const provisionIndex = steps.findIndex(
    (step) => step.id === "provision-chrome",
  );
  const heavyIndex = steps.findIndex(
    (step) => step.name === "Run heavy E2E regression suite",
  );
  const heavyStep = steps[heavyIndex];

  test("provisions a Chrome binary before the heavy step", () => {
    expect(provisionIndex).toBeGreaterThanOrEqual(0);
    expect(heavyIndex).toBeGreaterThan(provisionIndex);
    const provision = steps[provisionIndex];
    expect(provision?.run).toContain("@puppeteer/browsers install chrome");
    expect(provision?.run).toContain("chrome-path=");
  });

  test("runs the real heavy lane with the live-gating env, not a bare skip-to-green call", () => {
    expect(heavyStep?.run).toBe("bun run test:e2e:heavy");
    expect(heavyStep?.env?.ELIZA_LIVE_TEST).toBe("1");
    expect(heavyStep?.env?.ELIZA_CHROME_PATH).toBe(
      "$" + "{{ steps.provision-chrome.outputs.chrome-path }}",
    );
  });

  test("maps at least one live provider key secret the suites accept", () => {
    const providerEnvNames = Object.keys(heavyStep?.env ?? {}).filter((name) =>
      LIVE_PROVIDER_KEY_ENV_VARS.includes(name),
    );
    expect(providerEnvNames.length).toBeGreaterThan(0);
    for (const name of providerEnvNames) {
      expect(heavyStep?.env?.[name]).toContain("secrets.");
    }
  });

  test("cannot soften a red heavy lane", () => {
    expect(heavyStep?.["continue-on-error"]).toBeUndefined();
    expect(heavyStep?.run).not.toContain("|| true");
  });
});

describe("evaluateHeavyPreflight", () => {
  const readyEnv = {
    ELIZA_LIVE_TEST: "1",
    ELIZA_CHROME_PATH: "/fake/chrome",
    GROQ_API_KEY: "gsk_fake",
  };
  const chromeExists = (candidate: string) => candidate === "/fake/chrome";

  test("passes only when every prerequisite is present", () => {
    expect(
      evaluateHeavyPreflight(readyEnv, { fileExists: chromeExists }),
    ).toEqual([]);
  });

  test("rejects a missing ELIZA_LIVE_TEST flag", () => {
    const { ELIZA_LIVE_TEST: _drop, ...env } = readyEnv;
    const failures = evaluateHeavyPreflight(env, { fileExists: chromeExists });
    expect(failures.join("\n")).toContain("ELIZA_LIVE_TEST=1");
  });

  test("rejects a Chrome path that does not exist", () => {
    const failures = evaluateHeavyPreflight(readyEnv, {
      fileExists: () => false,
    });
    expect(failures.join("\n")).toContain("/fake/chrome");
  });

  test("falls back to the suites' default Chrome path when unset", () => {
    const probed: string[] = [];
    const { ELIZA_CHROME_PATH: _drop, ...env } = readyEnv;
    evaluateHeavyPreflight(env, {
      fileExists: (candidate: string) => {
        probed.push(candidate);
        return false;
      },
    });
    expect(probed).toEqual([DEFAULT_CHROME_PATH]);
  });

  test("rejects missing or whitespace-only provider keys", () => {
    const failures = evaluateHeavyPreflight(
      {
        ELIZA_LIVE_TEST: "1",
        ELIZA_CHROME_PATH: "/fake/chrome",
        GROQ_API_KEY: "   ",
      },
      { fileExists: chromeExists },
    );
    expect(failures.join("\n")).toContain("provider API key");
  });

  test("accepts the CI-scoped ELIZA_E2E_* provider aliases", () => {
    const failures = evaluateHeavyPreflight(
      {
        ELIZA_LIVE_TEST: "1",
        ELIZA_CHROME_PATH: "/fake/chrome",
        ELIZA_E2E_GROQ_API_KEY: "gsk_fake",
      },
      { fileExists: chromeExists },
    );
    expect(failures).toEqual([]);
  });
});

describe("assertExecutedHeavyRun", () => {
  const cwd = "/repo/packages/app-core";
  const files = HEAVY_SUITE_FILES;

  function summaryWith(statusesByFile: Record<string, string[]>) {
    return {
      testResults: Object.entries(statusesByFile).map(([file, statuses]) => ({
        name: path.resolve(cwd, file),
        assertionResults: statuses.map((status) => ({ status })),
      })),
    };
  }

  test("accepts a run where both suites executed assertions", () => {
    const summary = summaryWith({
      [files[0]]: ["passed", "passed"],
      [files[1]]: ["passed"],
    });
    expect(() => assertExecutedHeavyRun(summary, files, cwd)).not.toThrow();
  });

  test("rejects a fully skipped run — the original vacuous-green shape", () => {
    const summary = summaryWith({
      [files[0]]: ["skipped"],
      [files[1]]: ["skipped"],
    });
    expect(() => assertExecutedHeavyRun(summary, files, cwd)).toThrow(
      /skipped/,
    );
  });

  test("rejects a run where one suite silently skipped", () => {
    const summary = summaryWith({
      [files[0]]: ["passed"],
      [files[1]]: ["pending"],
    });
    expect(() => assertExecutedHeavyRun(summary, files, cwd)).toThrow();
  });

  test("rejects a run where a named suite is absent from the summary", () => {
    const summary = summaryWith({ [files[0]]: ["passed"] });
    expect(() => assertExecutedHeavyRun(summary, files, cwd)).toThrow(
      /zero assertions/,
    );
  });

  test("rejects an empty summary and a malformed summary", () => {
    expect(() =>
      assertExecutedHeavyRun({ testResults: [] }, files, cwd),
    ).toThrow();
    expect(() => assertExecutedHeavyRun({}, files, cwd)).toThrow(/testResults/);
  });
});

describe("extractForwardedTestFiles", () => {
  test("keeps positional files and drops --config with its value", () => {
    expect(
      extractForwardedTestFiles([
        "--config",
        "vitest.app-real-e2e.config.ts",
        ...HEAVY_SUITE_FILES,
      ]),
    ).toEqual(HEAVY_SUITE_FILES);
  });
});

describe("run-heavy-e2e.mjs production entrypoint", () => {
  const heavyScript = "test:e2e:heavy";
  const scrubbedEnv: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
  };

  function runHeavyLane(extraEnv: Record<string, string>) {
    return spawnSync("bun", ["run", heavyScript], {
      cwd: repoRoot,
      env: { ...scrubbedEnv, ...extraEnv },
      encoding: "utf8",
      timeout: 120_000,
    });
  }

  test("the real release-gate command exits red, not green, with no live env", () => {
    const result = runHeavyLane({});
    expect(result.status).not.toBe(0);
    const output = `${result.stdout}\n${result.stderr}`;
    expect(output).toContain("ELIZA_LIVE_TEST=1");
    expect(output).toContain("fails closed");
  });

  test("a live flag alone is not enough: browser and provider gaps stay red", () => {
    const result = runHeavyLane({
      ELIZA_LIVE_TEST: "1",
      ELIZA_CHROME_PATH: "/nonexistent/heavy-e2e-chrome",
    });
    expect(result.status).not.toBe(0);
    const output = `${result.stdout}\n${result.stderr}`;
    expect(output).toContain("/nonexistent/heavy-e2e-chrome");
    expect(output).toContain("provider API key");
  });
});
