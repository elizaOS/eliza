// Defines the schedule plan capability LifeOps scenario-runner spec.
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
 * `resolveOptimizedPromptForRuntime(..., "schedule_plan", ...)` swaps for a
 * registered `schedule_plan` artifact, and the model call is tagged with
 * `purpose: "schedule_plan"` for trajectory capture.
 *
 * Negotiation intents ("set up a meeting", "cancel that negotiation",
 * "list my open negotiations") route to the `PERSONAL_ASSISTANT` umbrella
 * action with `action=scheduling` (`PERSONAL_ASSISTANT_ACTIONS` in
 * `owner-surfaces.ts`). The umbrella is registered through
 * `promoteSubactionsToActions`, so the planner can equivalently select the
 * promoted virtual `PERSONAL_ASSISTANT_SCHEDULING`, which injects
 * `"action":"scheduling"` before delegating to the same handler. Only
 * `action=scheduling` reaches `runSchedulingNegotiationHandler`, which is the
 * sole caller of `buildSchedulingPlanPrompt`; the sibling subactions
 * `action=book_travel` and `action=sign_document` (promoted:
 * `PERSONAL_ASSISTANT_BOOK_TRAVEL` / `PERSONAL_ASSISTANT_SIGN_DOCUMENT`)
 * never invoke the `schedule_plan` prompt.
 *
 * What this scenario proves (machine-enforced):
 *   - In at least one turn the router selects the scheduling subaction —
 *     either the umbrella `PERSONAL_ASSISTANT` carrying
 *     `"action":"scheduling"` or the promoted virtual
 *     `PERSONAL_ASSISTANT_SCHEDULING`. The `selectedActionArguments` final
 *     check is read by the executor
 *     (`packages/scenario-runner/src/final-checks/index.ts`): it filters the
 *     captured actions to the accepted names and matches the regex against
 *     the action name + `JSON.stringify(parameters)` + result text. The
 *     regex requires the structured discriminator (or the virtual name), not
 *     the bare word "scheduling", so result text that merely mentions
 *     scheduling cannot satisfy it. Because only `action=scheduling` reaches
 *     `buildSchedulingPlanPrompt`, this is the *load-bearing* assertion: it
 *     fails unless the schedule_plan prompt path actually runs, so — unlike a
 *     bare `selectedAction` check — it cannot be satisfied by a `book_travel`
 *     / `sign_document` route to the same umbrella action.
 *
 * What this scenario does NOT prove:
 *   - It does not grade the structured plan the model returns, nor the text of
 *     the `schedule_plan` prompt output. It proves the prompt path runs, not
 *     that the LLM authored a high-quality negotiation plan.
 *
 * It mirrors `calendar-extract-capability` / `inbox-triage-capability` but is
 * scoped to the schedule-plan capability.
 */
export default scenario({
  lane: "live-only",
  id: "schedule-plan-capability",
  title:
    "Schedule plan capability routes a negotiation request to PERSONAL_ASSISTANT scheduling",
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
    },
    {
      kind: "message",
      name: "plan-list-negotiations",
      text: "List my open scheduling negotiations.",
    },
    {
      kind: "message",
      name: "plan-cancel-negotiation",
      text: "Cancel the scheduling negotiation for the quarterly review.",
    },
  ],
  finalChecks: [
    // Load-bearing assertion. `selectedActionArguments` filters captured
    // actions to the accepted names — the umbrella AND its promoted virtual —
    // and requires the structured scheduling discriminator (either the
    // injected `"action":"scheduling"` parameter or the promoted
    // PERSONAL_ASSISTANT_SCHEDULING name). Without `action=scheduling` the
    // `schedule_plan` prompt is never reached, so this fails — unlike a bare
    // `selectedAction` check it cannot be satisfied by a book_travel /
    // sign_document route, and unlike a bare "scheduling" substring it cannot
    // be satisfied by result text that merely mentions scheduling. It fires
    // when any one of the turns above selects the scheduling subaction, not
    // all three.
    {
      type: "selectedActionArguments",
      name: "personal-assistant routed to the scheduling subaction (exercises schedule_plan prompt path)",
      actionName: ["PERSONAL_ASSISTANT", "PERSONAL_ASSISTANT_SCHEDULING"],
      includesAll: [/\bPERSONAL_ASSISTANT_SCHEDULING\b|"action":"scheduling"/],
    },
    {
      type: "modelCallOccurred",
      name: "schedule_plan optimized-prompt model call fired",
      purpose: "schedule_plan",
      minCount: 1,
    },
  ],
});
