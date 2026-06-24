import { scenario } from "@elizaos/scenario-runner/schema";

/**
 * Behavior scenario for the `schedule_plan` LifeOps capability.
 *
 * The scheduling-negotiation planner (`buildSchedulingPlanPrompt` /
 * `resolveSchedulingPlanWithLlm` in
 * `plugins/plugin-personal-assistant/src/actions/lib/scheduling-handler.ts`)
 * turns a natural-language meeting-coordination request into a structured
 * negotiation plan: a `subaction` (start / propose / respond / finalize /
 * cancel / list_active / list_proposals / null) plus `shouldAct`. Its
 * instruction body is the GEPA-optimizable `schedule_plan` prompt:
 * `SCHEDULE_PLAN_INSTRUCTIONS` is the wired baseline that
 * `resolveOptimizedPromptForRuntime` swaps for a registered `schedule_plan`
 * artifact, and the model call is tagged with `purpose: "schedule_plan"` for
 * trajectory capture.
 *
 * Negotiation intents ("set up a meeting", "cancel that negotiation",
 * "list my open negotiations") route to the `PERSONAL_ASSISTANT` umbrella
 * action with `action=scheduling` (see `runSchedulingNegotiationHandler` in
 * `owner-surfaces.ts`). This scenario asserts each request reaches the
 * `PERSONAL_ASSISTANT` action and adds a final selected-action check so a
 * regression in the wired prompt or the routing surfaces as a failing
 * scenario. It mirrors `calendar-extract-capability` /
 * `inbox-triage-capability` but is scoped to the schedule-plan capability.
 */
export default scenario({
  lane: "live-only",
  id: "schedule-plan-capability",
  title: "Schedule plan capability routes negotiation requests to PERSONAL_ASSISTANT",
  domain: "scheduling",
  tags: ["lifeops", "scheduling", "schedule_plan", "llm-eval"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      title: "LifeOps Schedule Plan Capability",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "plan-start-negotiation",
      text: "Start a scheduling negotiation with Priya to find a time for our quarterly review.",
      plannerIncludesAll: ["PERSONAL_ASSISTANT"],
      plannerExcludes: ["create_task", "spawn_agent", "list_agents"],
    },
    {
      kind: "message",
      name: "plan-list-negotiations",
      text: "List my open scheduling negotiations.",
      plannerIncludesAll: ["PERSONAL_ASSISTANT"],
      plannerExcludes: ["create_task", "spawn_agent", "list_agents"],
    },
    {
      kind: "message",
      name: "plan-cancel-negotiation",
      text: "Cancel the scheduling negotiation for the quarterly review.",
      plannerIncludesAll: ["PERSONAL_ASSISTANT"],
      plannerExcludes: ["create_task", "spawn_agent", "list_agents"],
    },
  ],
  finalChecks: [
    {
      type: "selectedAction",
      name: "personal assistant action selected for every schedule-plan turn",
      actionName: "PERSONAL_ASSISTANT",
    },
  ],
});
