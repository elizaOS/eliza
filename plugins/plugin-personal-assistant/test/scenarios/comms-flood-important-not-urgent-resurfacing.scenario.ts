/**
 * D1 comms-flood-triage (live). dre_flood flags a message as important-but-not-
 * urgent and explicitly does NOT want it surfaced now — but it must not vanish
 * either. The assistant must capture a deferred resurfacing record so the item
 * comes back on its own later (e.g. end-of-day), separating the urgency axis from
 * the importance axis. Ports the D1 "important-not-urgent resurfacing" premise
 * (#12281 tier rubric T3 / #12283 D1 table).
 *
 * Personas-as-data: the "important not urgent, resurface later" instruction lives
 * in the turn text, never in `promptInstructions` (root AGENTS.md — one
 * scheduler, structural fields only).
 *
 * OUTCOME (not echo/routing): a store-agnostic predicate proves exactly one
 * deferred resurfacing record was created — as an owner definition OR a
 * scheduled task with a real future-firing trigger (live models route this
 * hold-and-resurface capture through SCHEDULED_TASKS create as often as the
 * definitions lane) — and the judge grades the load-bearing nuance — held for
 * later, not surfaced now, not dropped.
 */
import type { ScenarioContext } from "@elizaos/scenario-runner/schema";
import { scenario } from "@elizaos/scenario-runner/schema";

const INVESTOR_TITLE = /investor/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Exactly one new investor-update resurfacing record across both owner stores.
 * The original definitionCountDelta bar (one record, delta:1, no pinned-time
 * requirement) is unchanged — only the storage surface is widened. A scheduled
 * task counts only with a trigger that actually fires later (once/cron/
 * interval/during_window/relative_to_anchor/event/after_task — anything except
 * manual, which would leave the item waiting on a human and thus dropped).
 */
async function singleResurfacingRecordExists(
  ctx: ScenarioContext,
): Promise<string | undefined> {
  const runtime = ctx.runtime as { agentId?: string };
  const matches: string[] = [];

  const { LifeOpsService } = await import(
    "@elizaos/plugin-personal-assistant/lifeops/service"
  );
  const service = new LifeOpsService(
    ctx.runtime as unknown as ConstructorParameters<typeof LifeOpsService>[0],
  );
  for (const entry of await service.listDefinitions()) {
    const rec = isRecord(entry)
      ? ((entry as { definition?: unknown }).definition ?? entry)
      : null;
    if (!isRecord(rec) || typeof rec.title !== "string") continue;
    if (INVESTOR_TITLE.test(rec.title)) {
      matches.push(`definition "${rec.title}"`);
    }
  }

  const { LifeOpsRepository } = await import(
    "@elizaos/plugin-personal-assistant"
  );
  const repo = new LifeOpsRepository(
    ctx.runtime as unknown as ConstructorParameters<
      typeof LifeOpsRepository
    >[0],
  );
  for (const task of await repo.listScheduledTasks(
    String(runtime.agentId ?? ""),
  )) {
    const rec = task as unknown as Record<string, unknown>;
    const text = `${String(rec.taskId ?? "")} ${String(
      (isRecord(rec.metadata) ? rec.metadata.description : "") ?? "",
    )} ${String(rec.promptInstructions ?? "")}`;
    if (!INVESTOR_TITLE.test(text)) continue;
    const trigger = isRecord(rec.trigger) ? rec.trigger : {};
    const kind = String(trigger.kind ?? trigger.type ?? "");
    if (kind !== "" && kind !== "manual") {
      matches.push(`task ${String(rec.taskId)} (${kind} trigger)`);
    }
  }

  if (matches.length === 1) return undefined;
  return (
    `expected exactly one investor-update resurfacing record across the ` +
    `definitions and scheduled-task stores; matched ${matches.length}` +
    (matches.length > 0 ? ` [${matches.join("; ")}]` : "")
  );
}

export default scenario({
  lane: "live-only",
  id: "comms-flood-important-not-urgent-resurfacing",
  title:
    "Comms flood: an important-not-urgent item is held and resurfaces later, not dropped",
  domain: "lifeops.inbox",
  tags: ["lifeops", "comms-flood", "personas", "12283"],
  status: "active",
  isolation: "per-scenario",
  requires: { plugins: ["@elizaos/plugin-personal-assistant"] },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Comms triage",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "dre flags an important-not-urgent item to resurface later",
      text: "the investor update thread from MariELla is important but it is NOT urgent — do not throw it at me now while i'm slammed, but do NOT let it disappear either. bring it back to me at the end of the day so i actually deal with it.",
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "single-deferred-resurfacing-record-exists",
      predicate: singleResurfacingRecordExists,
    },
    {
      type: "judgeRubric",
      name: "held-and-resurfaces-not-dropped-not-now",
      minimumScore: 0.6,
      rubric:
        "The owner flagged a specific thread (the investor update from MariElla) as IMPORTANT but explicitly NOT urgent: do not surface it now, but do not let it vanish — bring it back at end of day. Grade PASS only if the assistant set up a deferred resurfacing (a hold-and-resurface record scheduled for later, e.g. end of day) rather than surfacing it immediately AND rather than silently dropping it. Deduct heavily if it surfaced the item now against the owner's request, treated it as urgent, or acknowledged it without creating anything that would bring it back later.",
    },
  ],
});
