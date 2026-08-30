/**
 * Live-provider proof that a natural-language scheduling request reaches the
 * real personal-assistant scheduling planner and persists a negotiation. The
 * single turn isolates Codex-to-elizaOS routing from the separate deterministic
 * CRUD and long-horizon scheduler stress scenarios.
 */
import type { ScenarioContext } from "@elizaos/scenario-runner/schema";
import { scenario } from "@elizaos/scenario-runner/schema";
import { LifeOpsService } from "../../../../plugins/plugin-personal-assistant/src/lifeops/service.ts";

async function assertPersistedNegotiation(
  ctx: ScenarioContext,
): Promise<string | undefined> {
  const service = new LifeOpsService(ctx.runtime);
  const negotiations = await service.listActiveNegotiations({ limit: 50 });
  const negotiation = negotiations.find(
    (candidate) =>
      candidate.state === "initiated" &&
      candidate.subject.includes("quarterly review"),
  );
  if (!negotiation) {
    return "expected an initiated quarterly-review negotiation in the LifeOps repository";
  }
  await service.cancelNegotiation(negotiation.id, "scenario cleanup");
  return undefined;
}

export default scenario({
  id: "live-schedule-negotiation-action",
  lane: "live-only",
  title: "Live model starts an elizaOS scheduling negotiation",
  domain: "scheduling",
  tags: ["live", "scheduling", "codex", "schedule-plan"],
  isolation: "per-scenario",
  rooms: [
    {
      id: "main",
      source: "dashboard",
      title: "Live Schedule Negotiation Action",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "start-quarterly-review-negotiation",
      text: "Start a scheduling negotiation with Priya to find a time for our quarterly review.",
    },
  ],
  finalChecks: [
    {
      type: "selectedActionArguments",
      name: "personal-assistant scheduling action persisted the negotiation",
      actionName: ["PERSONAL_ASSISTANT", "PERSONAL_ASSISTANT_SCHEDULING"],
      includesAll: [/\bPERSONAL_ASSISTANT_SCHEDULING\b|"action":"scheduling"/],
    },
    {
      type: "modelCallOccurred",
      name: "schedule-plan model call executed",
      purpose: "schedule_plan",
      minCount: 1,
    },
    {
      type: "custom",
      name: "LifeOps repository contains the initiated negotiation",
      predicate: assertPersistedNegotiation,
    },
  ],
});
