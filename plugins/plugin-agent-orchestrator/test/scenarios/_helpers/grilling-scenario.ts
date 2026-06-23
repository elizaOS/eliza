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

/** A deterministic stand-in for the verifier model: PASS only when the prompt
 * (which embeds the completion evidence) carries a pasted passing-test line —
 * exactly the discrimination a real judge makes. Mirrors the live model's
 * behavior closely enough to keep the keyless lane green. */
export const contentAwareVerifierModel: VerifierModel = async (
  ..._args: unknown[]
) => {
  const opts = _args[1] as { prompt?: string } | undefined;
  const prompt = opts?.prompt ?? "";
  const hasPassingTests =
    /\d+\s+passing|tests?\s+pass(ed)?\b.*\d|0\s+fail/i.test(prompt);
  return JSON.stringify(
    hasPassingTests
      ? { passed: true, summary: "all criteria proven", missing: [] }
      : {
          passed: false,
          summary: "no pasted test output",
          missing: ["tests pass"],
        },
  );
};

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

    // Round 2: re-report WITH pasted passing test output → verified done.
    acp.emit(sessionId, "task_complete", {
      response:
        "Done. Ran `npm test` — 12 passing, 0 failing. The widget renders correctly.",
    });
    const done = await waitFor(
      async () => (await store.getTask(taskId))?.task.status === "done",
    );
    if (!done) {
      const status = (await store.getTask(taskId))?.task.status;
      return `task was not verified done after pasted evidence; status=${status}`;
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
