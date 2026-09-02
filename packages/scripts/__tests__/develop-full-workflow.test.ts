/** Verifies the sole develop-push workflow delegates and aggregates every read-only validation family. */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const workflowPath = fileURLToPath(
  new URL("../../../.github/workflows/develop-full.yml", import.meta.url),
);
const workflow = Bun.YAML.parse(readFileSync(workflowPath, "utf8")) as {
  on?: Record<string, { branches?: string[] }>;
  concurrency?: { group?: string; "cancel-in-progress"?: boolean };
  permissions?: Record<string, string>;
  jobs?: Record<
    string,
    {
      uses?: string;
      needs?: string | string[];
      if?: string;
      permissions?: Record<string, string>;
      secrets?: string;
      steps?: Array<{
        name?: string;
        uses?: string;
        run?: string;
        with?: Record<string, string>;
      }>;
    }
  >;
};
const qualityWorkflow = readFileSync(
  fileURLToPath(
    new URL("../../../.github/workflows/quality.yml", import.meta.url),
  ),
  "utf8",
);
const testWorkflow = Bun.YAML.parse(
  readFileSync(
    fileURLToPath(
      new URL("../../../.github/workflows/test.yml", import.meta.url),
    ),
    "utf8",
  ),
) as {
  jobs?: Record<
    string,
    {
      steps?: Array<{
        name?: string;
        run?: string;
        with?: Record<string, string>;
      }>;
    }
  >;
};
const promptsPackage = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../../prompts/package.json", import.meta.url)),
    "utf8",
  ),
) as {
  elizaos?: {
    scripts?: {
      buildOnInstall?: { sentinel?: string; order?: number; script?: string };
    };
  };
};
const corePackage = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../../core/package.json", import.meta.url)),
    "utf8",
  ),
) as {
  elizaos?: {
    scripts?: { buildOnInstall?: { sentinel?: string; order?: number } };
  };
};
const surfaceGraph = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL("../../../.github/develop-surface-graph.json", import.meta.url),
    ),
    "utf8",
  ),
) as {
  knownNonValidationInputs?: string[];
  reusePolicy?: string;
  surfaces: Array<{ id: string; workflow: string; inputs: string[] }>;
};

const delegatedJobs = [
  "canonical",
  "chat-shell",
  "cloud-gateway-discord",
  "cloud",
  "dev-smoke",
  "docker",
  "secrets",
  "quality",
  "platform-smoke",
  "scenarios",
  "tests",
  "ui-core",
  "ui-extended",
  "ui-stories",
];

describe("Develop Full workflow authority", () => {
  test("is the latest-tip develop-push authority", () => {
    expect(workflow.on).toEqual({ push: { branches: ["develop"] } });
    expect(workflow.concurrency).toEqual({
      group: "develop-full",
      "cancel-in-progress": true,
    });
  });

  test("delegates the complete read-only validation graph", () => {
    expect(Object.keys(workflow.jobs ?? {}).sort()).toEqual(
      [...delegatedJobs, "complete", "handoff-effects", "plan"].sort(),
    );
    for (const name of delegatedJobs) {
      const job = workflow.jobs?.[name];
      expect(job?.uses).toMatch(/^\.\/\.github\/workflows\/.+\.yml$/);
      if (name === "platform-smoke" || name === "cloud-gateway-discord") {
        expect(job?.secrets).toBeUndefined();
      } else {
        expect(job?.secrets).toBe("inherit");
      }
      expect(job?.permissions).toBeUndefined();
      expect(job?.needs).toBe("plan");
      expect(job?.if).toContain("needs.plan.outputs.run_");
    }
    expect(workflow.permissions).toEqual({ contents: "read" });
  });

  test("registers each delegated family exactly once with the called workflow", () => {
    expect(surfaceGraph.surfaces.map(({ id }) => id).sort()).toEqual(
      [...delegatedJobs].sort(),
    );
    for (const surface of surfaceGraph.surfaces) {
      expect(workflow.jobs?.[surface.id]?.uses).toBe(`./${surface.workflow}`);
    }
  });

  test("routes guides and documentation through real quality validation", () => {
    expect(surfaceGraph.knownNonValidationInputs ?? []).toEqual([]);
    const quality = surfaceGraph.surfaces.find(
      (surface) => surface.id === "quality",
    );
    expect(quality?.inputs).toEqual(
      expect.arrayContaining(["*.md", "**/*.md", "packages/docs/**"]),
    );
    expect(qualityWorkflow).toContain("bun run check:agents-claude");
    expect(qualityWorkflow).toContain("node scripts/check-markdown-links.mjs");
  });

  test("fails closed unless every delegated family has current evidence", () => {
    expect(surfaceGraph.reusePolicy).toBe("current-run-only");
    const complete = workflow.jobs?.complete;
    expect(complete?.if).toBe(
      `\${{ always() && !cancelled() && needs.plan.result == 'success' }}`,
    );
    expect(complete?.needs).toEqual(["plan", ...delegatedJobs]);
    expect(
      complete?.steps?.some((step) =>
        step.run?.includes("develop-impact-evidence.mjs record"),
      ),
    ).toBe(true);
  });

  test("guards every develop-reachable always job against cancellation", () => {
    const nonPushOnlyAlwaysJobs = new Map([
      [
        ".github/workflows/test.yml#github-live-artifact-validate",
        "always() && (github.event_name == 'workflow_dispatch' || github.event_name == 'schedule') && (needs.cloud-live-e2e.outputs.capability_skip != 'true' || needs.provider-live-e2e.outputs.skip != 'true')",
      ],
    ]);
    const expressionBody = (condition: string) =>
      condition
        .replace(/^\$\{\{\s*/, "")
        .replace(/\s*\}\}$/, "")
        .trim();
    const canonicalExpression = (condition: string) =>
      expressionBody(condition).replace(
        /\b(?:always|cancelled)\s*\(\s*\)/gi,
        (statusCall) => statusCall.replace(/\s/g, "").toLowerCase(),
      );
    const mentionsAlways = (condition: string) =>
      canonicalExpression(condition).includes("always()");
    const hasTopLevelDisjunction = (expression: string) => {
      let depth = 0;
      let quote: "'" | '"' | null = null;

      for (let index = 0; index < expression.length; index += 1) {
        const character = expression[index];
        if (quote) {
          if (character === quote) {
            if (quote === "'" && expression[index + 1] === "'") {
              index += 1;
            } else {
              quote = null;
            }
          }
          continue;
        }
        if (character === "'" || character === '"') {
          quote = character;
        } else if (character === "(") {
          depth += 1;
        } else if (character === ")") {
          depth -= 1;
          if (depth < 0) return true;
        } else if (
          depth === 0 &&
          character === "|" &&
          expression[index + 1] === "|"
        ) {
          return true;
        }
      }

      return depth !== 0 || quote !== null;
    };
    const isCancellationAwareAlways = (condition: string) => {
      const expression = canonicalExpression(condition);
      return (
        !hasTopLevelDisjunction(expression) &&
        /^(?:always\(\)\s*&&\s*!cancelled\(\)|!cancelled\(\)\s*&&\s*always\(\))(?:\s*&&|$)/.test(
          expression,
        )
      );
    };

    for (const unsafe of [
      "always() && cancelled()",
      "always() || !cancelled()",
      "always() && !cancelled() || github.event_name == 'push'",
      "always() && !cancelled() && needs.plan.result == 'success' || github.event_name == 'push'",
      "!cancelled() && always() && needs.plan.result == 'success' || github.event_name == 'push'",
      "always() && !cancelled() && true || cancelled()",
      "always( )",
      "ALWAYS()",
    ]) {
      expect(mentionsAlways(unsafe), unsafe).toBe(true);
      expect(isCancellationAwareAlways(unsafe), unsafe).toBe(false);
    }
    expect(
      isCancellationAwareAlways(
        "!cancelled() && always() && (github.event_name != 'pull_request' || needs.changes.outputs.zero_key == 'true')",
      ),
    ).toBe(true);
    expect(isCancellationAwareAlways("ALWAYS( ) && !cancelled( )")).toBe(true);
    const visited = new Set<string>();
    const pending = [".github/workflows/develop-full.yml"];
    const offenders: string[] = [];

    while (pending.length > 0) {
      const relativePath = pending.shift();
      if (!relativePath || visited.has(relativePath)) continue;
      visited.add(relativePath);

      const candidate = Bun.YAML.parse(
        readFileSync(
          fileURLToPath(new URL(`../../../${relativePath}`, import.meta.url)),
          "utf8",
        ),
      ) as typeof workflow;

      for (const [jobId, job] of Object.entries(candidate.jobs ?? {})) {
        const key = `${relativePath}#${jobId}`;
        const condition = job.if ?? "";
        if (
          mentionsAlways(condition) &&
          !isCancellationAwareAlways(condition)
        ) {
          if (expressionBody(condition) !== nonPushOnlyAlwaysJobs.get(key)) {
            offenders.push(key);
          }
        }

        if (job.uses?.startsWith("./.github/workflows/")) {
          pending.push(job.uses.slice(2));
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  test("uses exact digest cache keys and publishes the manifest artifact", () => {
    const plan = workflow.jobs?.plan;
    const complete = workflow.jobs?.complete;
    const planCaches = plan?.steps?.filter((step) =>
      step.uses?.startsWith("actions/cache/restore@"),
    );
    const completeCaches = complete?.steps?.filter((step) =>
      step.uses?.startsWith("actions/cache@"),
    );
    expect(planCaches).toHaveLength(delegatedJobs.length);
    expect(completeCaches).toHaveLength(delegatedJobs.length);
    for (const step of [...(planCaches ?? []), ...(completeCaches ?? [])]) {
      expect(step.with?.key).toMatch(
        /^develop-evidence-v1-.+-\$\{\{ .+\.outputs\.digest_/,
      );
      expect(step.with?.["restore-keys"]).toBeUndefined();
    }
    expect(
      complete?.steps?.some((step) =>
        step.uses?.startsWith("actions/upload-artifact@"),
      ),
    ).toBe(true);
  });

  test("hands only the successful exact aggregate to durable reconciliation", () => {
    const handoff = workflow.jobs?.["handoff-effects"];
    expect(handoff?.needs).toBe("complete");
    expect(handoff?.if).toBe(`\${{ needs.complete.result == 'success' }}`);
    expect(handoff?.permissions).toEqual({
      actions: "write",
      contents: "read",
    });
    expect(handoff?.steps?.[0]?.run).toContain(
      "/actions/workflows/develop-reconcile.yml/dispatches",
    );
    expect(handoff?.steps?.[0]?.run).toContain("inputs[source_sha]");
    expect(handoff?.steps?.[0]?.run).toContain("inputs[source_run_id]");
  });

  test("builds prompts before core for Electrobun diagnostics", () => {
    const steps = testWorkflow.jobs?.["zero-key-diagnostics"]?.steps ?? [];
    const setupIndex = steps.findIndex(
      (step) => step.name === "Setup workspace dependencies",
    );
    const diagnosticsIndex = steps.findIndex(
      (step) => step.name === "Electrobun window and dynamic-view coverage",
    );
    const promptsBuild = promptsPackage.elizaos?.scripts?.buildOnInstall;
    const coreBuild = corePackage.elizaos?.scripts?.buildOnInstall;
    expect(steps[setupIndex]?.with?.["run-postinstall"]).toBe("true");
    expect(promptsBuild?.sentinel).toBe("dist/index.js");
    expect(promptsBuild?.script).toBe("build:package");
    expect(coreBuild?.order).toBeGreaterThan(promptsBuild?.order ?? Infinity);
    expect(diagnosticsIndex).toBeGreaterThan(setupIndex);
  });
});
