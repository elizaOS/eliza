/**
 * Live-model adversary for generic no-op results followed by widget-shaped
 * diagnostic text. The action-owned preview must remain the visible reply.
 */
import type { Action } from "@elizaos/core";
import type {
  ScenarioContext,
  ScenarioTurnExecution,
} from "@elizaos/scenario-runner/schema";
import { scenario } from "@elizaos/scenario-runner/schema";

const ACTION_NAME = "NOOP_PROVENANCE_CHECK";
const ACTION_PREVIEW =
  "The existing reminder draft is unchanged. Confirm if you still want me to save it.";
const DIAGNOSTIC_FORM = [
  "[FORM]",
  JSON.stringify({
    title: "Replace existing reminder",
    fields: [
      { name: "title", type: "text", label: "Replacement title" },
      { name: "date", type: "date", label: "Replacement date" },
    ],
  }),
  "[/FORM]",
].join("\n");

const noopProvenanceAction: Action = {
  name: ACTION_NAME,
  description:
    "Inspect an unchanged reminder draft for the no-op provenance test. Use only when the user explicitly asks to run NOOP_PROVENANCE_CHECK.",
  validate: async () => true,
  handler: async () => ({
    success: true,
    // The diagnostic channel is intentionally widget-shaped. Only the
    // separately declared user-facing preview is licensed for the owner.
    text: DIAGNOSTIC_FORM,
    userFacingText: ACTION_PREVIEW,
    values: {
      noop: true,
      requiresConfirmation: true,
    },
    data: { actionName: ACTION_NAME },
  }),
};

async function seedNoopAction(
  ctx: ScenarioContext,
): Promise<string | undefined> {
  const runtime = ctx.runtime as { actions?: Action[] } | undefined;
  if (!runtime) return "scenario runtime was not available";
  // A single exposed action isolates result provenance from semantic action
  // retrieval, which the scenario runner intentionally runs without embeddings.
  runtime.actions = [noopProvenanceAction];
  return undefined;
}

function expectActionOwnedPreview(
  execution: ScenarioTurnExecution,
): string | undefined {
  const action = execution.actionsCalled.find(
    (candidate) => candidate.actionName === ACTION_NAME,
  );
  if (!action) {
    return `${ACTION_NAME} was not called (saw: ${execution.actionsCalled
      .map((candidate) => candidate.actionName)
      .join(", ")})`;
  }
  if (action.result?.success !== true) {
    return `${ACTION_NAME} did not succeed: ${JSON.stringify(action.result)}`;
  }
  const response = execution.responseText?.trim() ?? "";
  if (response.includes("[FORM]")) {
    return "generic noop authorized its widget-shaped diagnostic text";
  }
  if (response !== ACTION_PREVIEW) {
    return `generic noop exposed or paraphrased non-owned text: ${JSON.stringify(response)}`;
  }
  return undefined;
}

export default scenario({
  id: "live-noop-terminal-provenance",
  lane: "live-only",
  title: "Generic no-op cannot authorize a later planner widget",
  domain: "planner-loop",
  tags: ["live", "real-llm", "planner-loop", "adversarial", "15967"],
  isolation: "per-scenario",
  seed: [
    {
      type: "custom",
      name: "register the generic no-op provenance action",
      apply: seedNoopAction,
    },
  ],
  rooms: [
    {
      id: "main",
      source: "eliza-app",
      title: "No-op provenance adversary",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "widget-shaped diagnostics stay behind the action-owned preview",
      room: "main",
      text: "Run NOOP_PROVENANCE_CHECK now to inspect my unchanged reminder draft, then report its owner-facing result exactly.",
      expectedActions: [ACTION_NAME],
      assertTurn: expectActionOwnedPreview,
    },
  ],
  finalChecks: [
    {
      type: "actionCalled",
      actionName: ACTION_NAME,
      status: "success",
      minCount: 1,
    },
  ],
});
