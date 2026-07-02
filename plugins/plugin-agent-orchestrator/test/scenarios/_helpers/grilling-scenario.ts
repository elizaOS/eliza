/**
 * Shared logic for the orchestrator grilling scenarios (#8932). Each check
 * drives the REAL OrchestratorTaskService verification loop over a scripted ACP
 * (see `orchestrator-grilling-harness.ts`); the verifier model is injected so
 * the `.scenario.ts` can use the live model while
 * `orchestrator-scenario-logic.test.ts` uses a deterministic content-aware stub.
 */
import type { IAgentRuntime } from "@elizaos/core";
import {
  makeGrillingRuntime,
  makeScriptedAcp,
  OrchestratorTaskService,
  seedActiveTask,
  waitFor,
} from "./orchestrator-grilling-harness";

type VerifierModel = (...args: unknown[]) => Promise<unknown>;

function summarizeEvents(
  events: Array<{ eventType?: string; summary?: string; data?: unknown }>,
): string {
  return events
    .map((event) => {
      const data = event.data ? ` data=${JSON.stringify(event.data)}` : "";
      return `${event.eventType ?? "event"}: ${event.summary ?? ""}${data}`;
    })
    .join("\n")
    .slice(0, 3000);
}

/** A deterministic stand-in for the verifier model, tuned to mirror how a real
 * demanding judge (verified live against Cerebras `gemma-4-31b`) actually
 * discriminates: a self-reported summary line like "12 passing, 0 failing" is
 * NOT proof — the judge requires actual test-RUNNER output plus a code diff.
 * Keeping this in step with the live model matters: an over-lenient stub (the
 * prior `\d+ passing` regex accepted the bare summary) makes the keyless lane
 * green on evidence the live model correctly rejects, giving false confidence. */
export const contentAwareVerifierModel: VerifierModel = async (
  ..._args: unknown[]
) => {
  const opts = _args[1] as { prompt?: string } | undefined;
  const prompt = opts?.prompt ?? "";
  // Actual runner results block ("Tests 3 passed (3)" / "✓ file (N tests)" /
  // "Test Files 1 passed") — not just a claimed count.
  const hasRunnerOutput =
    /Test Files\s+\d+\s+passed|Tests?\s+\d+\s+passed\s*\(\d+\)|✓\s+.+\(\d+\s+tests?\)/i.test(
      prompt,
    );
  const hasDiff = /diff --git|^\+\+\+\s|^---\s/m.test(prompt);
  const passed = hasRunnerOutput && hasDiff;
  return JSON.stringify(
    passed
      ? {
          passed: true,
          summary: "raw test-runner output and a diff prove the criteria",
          missing: [],
        }
      : {
          passed: false,
          summary:
            "a self-reported claim is not proof — need actual test-runner output and a diff",
          missing: ["tests pass"],
        },
  );
};

/** Realistic "strong" completion a competent sub-agent would post: a code diff
 * plus the actual test-runner output, internally consistent (3 tests in the
 * diff → "3 passed (3)" in the output). Verified live: gemma-4-31b marks this
 * done, while rejecting both a bare summary and an inconsistent diff/output
 * pair. Shared so the deterministic and live grilling checks assert on the same
 * evidence a real sub-agent would produce. */
export const STRONG_COMPLETION_EVIDENCE = `Done. Implemented the widget and ran the tests.

\`\`\`diff
diff --git a/src/widget.ts b/src/widget.ts
new file mode 100644
--- /dev/null
+++ b/src/widget.ts
@@
+export function widget(n: number): number {
+  return n * 2;
+}
diff --git a/src/widget.test.ts b/src/widget.test.ts
new file mode 100644
--- /dev/null
+++ b/src/widget.test.ts
@@
+import { describe, it, expect } from "vitest";
+import { widget } from "./widget";
+describe("widget", () => {
+  it("doubles a positive", () => expect(widget(21)).toBe(42));
+  it("doubles zero", () => expect(widget(0)).toBe(0));
+  it("doubles a negative", () => expect(widget(-5)).toBe(-10));
+});
\`\`\`

\`\`\`
$ npm test

> widget@1.0.0 test
> vitest run

 RUN  v4.1.5 /work/widget
 ✓ src/widget.test.ts (3 tests) 41ms

 Test Files  1 passed (1)
      Tests  3 passed (3)
   Duration  0.63s
\`\`\`
`;

/**
 * grilling-happy-path: a sub-agent claims done with NO test output → the grill
 * round fires (corrective re-prompt citing the unmet criterion) → the sub-agent
 * re-reports WITH passing test output → the task is verified done.
 */
export async function runGrillingHappyPathCheck(
  baseRuntime: IAgentRuntime,
  verifierModel: VerifierModel,
): Promise<string | undefined> {
  const { store, taskId, sessionId } = await seedActiveTask(["tests pass"]);
  const acp = makeScriptedAcp();
  const runtime = makeGrillingRuntime(baseRuntime, acp.service, verifierModel);
  const service = new OrchestratorTaskService(runtime, { store });
  await service.start();
  try {
    // Round 1: claim done with no evidence → must be grilled, not accepted.
    acp.emit(sessionId, "task_complete", {
      response: "I implemented the widget and I believe it works.",
    });
    const grilled = await waitFor(() => acp.sent.length > 0);
    if (!grilled) return "the verifier never grilled a no-evidence completion";
    const grill = acp.sent.at(-1)?.text ?? "";
    if (!/tests pass/i.test(grill)) {
      return `the grill should cite the unmet criterion 'tests pass':\n${grill}`;
    }
    if ((await store.getTask(taskId))?.task.status === "done") {
      return "task was marked done despite no test evidence";
    }

    // Round 2: re-report WITH real test-runner output + diff → verified done.
    // (A bare "12 passing" summary is deliberately NOT used: the live judge
    // rejects it as an unproven claim — see STRONG_COMPLETION_EVIDENCE.)
    acp.emit(sessionId, "task_complete", {
      response: STRONG_COMPLETION_EVIDENCE,
    });
    const done = await waitFor(
      async () => (await store.getTask(taskId))?.task.status === "done",
    );
    if (!done) {
      const doc = await store.getTask(taskId);
      return `task was not verified done after pasted evidence; status=${doc?.task.status}\n${summarizeEvents(doc?.events ?? [])}`;
    }
    return undefined;
  } finally {
    await service.stop().catch(() => undefined);
  }
}

/**
 * grilling-evidence-bundle: assert the git diff AND the test stdout from the
 * sub-agent's completion actually reach the verifier's prompt (the verifier
 * judges typed evidence, not the bare event summary).
 */
export async function runGrillingEvidenceBundleCheck(
  baseRuntime: IAgentRuntime,
): Promise<string | undefined> {
  const { store, sessionId } = await seedActiveTask([
    "tests pass",
    "the implementation diff is included",
  ]);
  const acp = makeScriptedAcp();
  const prompts: string[] = [];
  const capturingModel: VerifierModel = async (..._args: unknown[]) => {
    const opts = _args[1] as { prompt?: string } | undefined;
    prompts.push(opts?.prompt ?? "");
    return JSON.stringify({ passed: true, summary: "ok", missing: [] });
  };
  const runtime = makeGrillingRuntime(baseRuntime, acp.service, capturingModel);
  const service = new OrchestratorTaskService(runtime, { store });
  await service.start();
  try {
    const DIFF =
      "diff --git a/src/widget.ts b/src/widget.ts\n+export const widget = () => 42;";
    const TEST_STDOUT = "npm test → 7 passing, 0 failing";
    acp.emit(sessionId, "task_complete", {
      response: `Implemented the widget.\n\n${DIFF}\n\n${TEST_STDOUT}`,
    });
    const called = await waitFor(() => prompts.length > 0);
    if (!called) {
      return "the verifier model was never called with the completion evidence";
    }
    const prompt = prompts.join("\n");
    if (
      !prompt.includes("widget.ts") ||
      !prompt.includes("export const widget")
    ) {
      return `the git diff did not reach the verifier prompt:\n${prompt.slice(0, 400)}`;
    }
    if (!prompt.includes("7 passing")) {
      return `the test stdout did not reach the verifier prompt:\n${prompt.slice(0, 400)}`;
    }
    return undefined;
  } finally {
    await service.stop().catch(() => undefined);
  }
}
