/**
 * D1 comms-flood-triage (live). dre_flood is drowning in low-signal pings and
 * asks the assistant to stop surfacing them one at a time and instead hold them
 * for a single batched digest. The assistant must capture a digest-window
 * preference (batch the non-VIP noise into one check) rather than firing an
 * individual reminder per message. Ports the D1 "digest-window batching" premise
 * (#12281 work-item 2 / #12283 D1 table).
 *
 * Personas-as-data: the batching ask lives in the turn text and the seeded
 * inbox-noise memory, never in `promptInstructions` (root AGENTS.md — one
 * scheduler, structural fields only).
 *
 * OUTCOME (not echo/routing): a store-agnostic predicate proves exactly one
 * recurring batched digest record was created — as an owner definition OR a
 * scheduled task (live models route this standing preference through
 * SCHEDULED_TASKS create as often as the definitions lane) — and the judge
 * grades the load-bearing nuance — batch, do not ping per message.
 */
import type { ScenarioContext } from "@elizaos/scenario-runner/schema";
import { scenario } from "@elizaos/scenario-runner/schema";

const DIGEST_TITLE = /digest|batch/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Exactly one new recurring digest record across both owner stores. The bar of
 * the original definitionCountDelta (one record, daily cadence, no pinned
 * time required) is unchanged — only the storage surface is widened: a daily
 * owner definition matches, and so does a scheduled task with a daily cron
 * trigger. One record total also preserves the "not a ping per message" edge.
 */
async function singleDailyDigestRecordExists(
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
    if (!DIGEST_TITLE.test(rec.title)) continue;
    const cadence = isRecord(rec.cadence) ? rec.cadence : {};
    if (cadence.kind === "daily") {
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
    if (!DIGEST_TITLE.test(text)) continue;
    const trigger = isRecord(rec.trigger) ? rec.trigger : {};
    const kind = trigger.kind ?? trigger.type;
    const expression =
      typeof trigger.expression === "string"
        ? trigger.expression
        : typeof trigger.cron === "string"
          ? trigger.cron
          : null;
    if (
      kind === "cron" &&
      expression !== null &&
      expression.trim().split(/\s+/).slice(2).join(" ") === "* * *"
    ) {
      matches.push(`task ${String(rec.taskId)} (cron "${expression}")`);
    }
  }

  if (matches.length === 1) return undefined;
  return (
    `expected exactly one recurring daily digest record across the ` +
    `definitions and scheduled-task stores; matched ${matches.length}` +
    (matches.length > 0 ? ` [${matches.join("; ")}]` : "")
  );
}

export default scenario({
  lane: "live-only",
  id: "comms-flood-digest-window-batching",
  title: "Comms flood: batch the noise into one digest, not a ping per message",
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
  seed: [
    {
      type: "memory",
      content: {
        text: "Owner fact: dre_flood runs six channels with 300+ messages a day; most of it is low-signal noise they do not want surfaced one at a time.",
      },
    },
  ],
  turns: [
    {
      kind: "message",
      name: "dre asks to batch everything except VIPs into one check",
      text: "stop pinging me for every little thing. just batch everything that isn't a VIP into ONE check at 5pm — i'll deal with the pile then. i don't want twelve separate notifications.",
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "single-recurring-digest-record-exists",
      predicate: singleDailyDigestRecordExists,
    },
    {
      type: "judgeRubric",
      name: "batches-into-one-digest-not-per-message",
      minimumScore: 0.6,
      rubric:
        "The owner asked the assistant to stop surfacing low-signal messages one at a time and instead hold all non-VIP traffic for a SINGLE batched digest check. Grade PASS only if the assistant set up ONE recurring batched digest (a single grouped check, e.g. once at 5pm) rather than an individual reminder per message, and conveyed that non-VIP noise will be collected and surfaced together instead of pinged individually. Deduct heavily if it created a separate reminder per message, or if it treated this as a one-off rather than a standing batching preference.",
    },
  ],
});
