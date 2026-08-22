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
      expect(job?.secrets).toBe("inherit");
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
      `\${{ always() && needs.plan.result == 'success' }}`,
    );
    expect(complete?.needs).toEqual(["plan", ...delegatedJobs]);
    expect(
      complete?.steps?.some((step) =>
        step.run?.includes("develop-impact-evidence.mjs record"),
      ),
    ).toBe(true);
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
});
