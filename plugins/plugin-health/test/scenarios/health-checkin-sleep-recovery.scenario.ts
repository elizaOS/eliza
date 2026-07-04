/**
 * Live-model scenario: a health check-in grounds its reply in the owner's sleep
 * and recovery signals.
 */
import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
  id: "health-checkin-sleep-recovery",
  title: "Health check-in grounds sleep and recovery signals",
  domain: "health",
  tags: ["health", "lifeops", "health_checkin"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-health", "@elizaos/plugin-agent-skills"],
  },
  turns: [
    {
      kind: "message",
      name: "health check-in",
      text: "Check in on my sleep and recovery today. If anything looks off, ask one focused follow-up instead of giving medical advice.",
    },
  ],
  // Load-bearing assertion. The previous turn-level
  // plannerIncludesAny/responseIncludesAny/plannerExcludes are NOT registered
  // final-check handlers (packages/scenario-runner/src/final-checks/index.ts),
  // so a regression in the optimized `health_checkin` prompt path would not fail
  // the run. `selectedActionArguments` IS consumed by the executor: it requires
  // OWNER_HEALTH to be selected AND a resolved subaction token to appear in the
  // captured action options. For an NL health request with no explicit subaction,
  // OWNER_HEALTH's runner (createHealthActionRunner) calls resolveHealthPlanWithLlm
  // — the sole caller of resolveOptimizedPromptForRuntime(..., "health_checkin", ...)
  // — so selecting OWNER_HEALTH with a real subaction proves that path ran.
  finalChecks: [
    {
      type: "selectedActionArguments",
      name: "health request routes to OWNER_HEALTH (exercises health_checkin prompt path)",
      actionName: "OWNER_HEALTH",
      includesAny: ["today", "trend", "by_metric", "status"],
    },
  ],
});
