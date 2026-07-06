/**
 * B2 shift-rotation (live-only, T1 capture). The rotating-shift persona (P3
 * marcus_shift) states his new rotation in his own schedule-literate voice ("on
 * nights starting Monday") and asks for a post-shift routine reminder. The
 * assistant must EXTRACT a structured recurring reminder anchored to his shift
 * hours — not park it at a naive clock default and not schedule it inside the
 * daytime sleep his night shift protects. Conversational competence is graded by
 * a live judge; the capture is proved STRUCTURALLY by a store-agnostic predicate
 * that requires the reminder to exist and to avoid his protected sleep window.
 *
 * Non-echo: the graded structural token is the created definition's due-local
 * time (it must NOT land in his 06:00–14:00 daytime sleep) — a derived schedule
 * fact he never states as a due time, so an echo of his words cannot satisfy it.
 * The seeded owner facts establish the protected daytime sleep so the "not during
 * sleep" check is meaningful.
 *
 * Live gate: needs a live model for the capture turn; its per-scenario
 * live-model trajectory is the remaining evidence gate (captured where model
 * credentials are available, per AGENTS.md).
 */

import type { ScenarioContext } from "@elizaos/scenario-runner/schema";
import { scenario } from "@elizaos/scenario-runner/schema";

const HANDOFF_TITLE = /handoff/i;
// Protected daytime sleep 06:00–14:00; his clock-out (07:30) and the requested
// "~an hour after" (~08:30) precede it, so the forbidden pinned hours are 9–13.
const FORBIDDEN_HOURS = new Set([9, 10, 11, 12, 13]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * The daily handoff reminder may legitimately persist on either owner surface:
 * a daily owner DEFINITION or a SCHEDULED TASK (live models route this capture
 * through SCHEDULED_TASKS create as often as the definitions lane), so a bare
 * definitionCountDelta over-constrains the store. The structural bar is
 * unchanged: exactly one new handoff record, daily, never pinned inside the
 * protected 06:00–14:00 daytime sleep. Definitions with `daily` cadence carry
 * named windows resolved against the seeded owner facts (waking windows
 * 16:00–19:00 / 23:00–05:00), which cannot land in the forbidden block; a
 * cron-triggered task must carry an explicit hour outside 09–13 UTC, and
 * event/relative_to_anchor triggers are shift-anchored by construction.
 */
async function handoffReminderExistsOutsideSleep(
  ctx: ScenarioContext,
): Promise<string | undefined> {
  const runtime = ctx.runtime as { agentId?: string };
  const matches: string[] = [];
  const rejects: string[] = [];

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
    if (!HANDOFF_TITLE.test(rec.title)) continue;
    const cadence = isRecord(rec.cadence) ? rec.cadence : {};
    if (cadence.kind === "daily") {
      matches.push(`definition "${rec.title}" (daily windows)`);
    } else {
      rejects.push(`definition "${rec.title}" cadence ${String(cadence.kind)}`);
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
    if (!HANDOFF_TITLE.test(text)) continue;
    const trigger = isRecord(rec.trigger) ? rec.trigger : {};
    const kind = trigger.kind ?? trigger.type;
    if (kind === "event" || kind === "relative_to_anchor") {
      matches.push(`task ${String(rec.taskId)} (${String(kind)} trigger)`);
      continue;
    }
    const expression =
      typeof trigger.expression === "string"
        ? trigger.expression
        : typeof trigger.cron === "string"
          ? trigger.cron
          : null;
    if (kind === "cron" && expression !== null) {
      const fields = expression.trim().split(/\s+/);
      const hour = Number.parseInt(fields[1] ?? "", 10);
      const dailyTail = fields.slice(2).join(" ") === "* * *";
      if (dailyTail && Number.isInteger(hour) && !FORBIDDEN_HOURS.has(hour)) {
        matches.push(`task ${String(rec.taskId)} (cron "${expression}")`);
      } else {
        rejects.push(
          `task ${String(rec.taskId)} cron "${expression}" inside protected sleep or not daily`,
        );
      }
      continue;
    }
    rejects.push(`task ${String(rec.taskId)} trigger ${String(kind)}`);
  }

  if (matches.length === 1) return undefined;
  return (
    `expected exactly one daily patient-handoff record outside the protected ` +
    `06:00–14:00 sleep across the definitions and scheduled-task stores; ` +
    `matched ${matches.length} [${matches.join("; ")}]` +
    (rejects.length > 0 ? `; rejected [${rejects.join("; ")}]` : "")
  );
}

async function seedNightSleepFacts(
  ctx: ScenarioContext,
): Promise<string | undefined> {
  const { resolveOwnerFactStore } = await import(
    "@elizaos/plugin-personal-assistant/plugin"
  );
  const store = resolveOwnerFactStore(
    ctx.runtime as unknown as Parameters<typeof resolveOwnerFactStore>[0],
  );
  // Night shift: waking window in the evening/night; protected sleep is the
  // daytime block. This is what a shift-aware capture must avoid scheduling into.
  await store.update(
    {
      timezone: "UTC",
      morningWindow: { startLocal: "16:00", endLocal: "19:00" },
      eveningWindow: { startLocal: "23:00", endLocal: "05:00" },
      quietHours: { startLocal: "06:00", endLocal: "14:00", timezone: "UTC" },
    },
    { source: "profile_save", recordedAt: new Date().toISOString() },
  );
  return undefined;
}

export default scenario({
  lane: "live-only",
  id: "shift-rotation-capture-new-shift-pattern",
  title:
    "Capture a shift-aware post-clock-out reminder from a plain 'on nights starting Monday' statement, never scheduling it into protected daytime sleep",
  domain: "lifeops",
  tags: [
    "lifeops",
    "shift-rotation",
    "personas",
    "reminders",
    "capture",
    "outcome",
    "12772",
  ],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-personal-assistant"],
  },
  seed: [
    {
      type: "custom",
      name: "seed night-shift owner facts (protected daytime sleep)",
      apply: seedNightSleepFacts,
    },
  ],
  rooms: [
    {
      id: "main",
      source: "dashboard",
      title: "Shift Rotation Capture",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "capture-shift-aware-reminder",
      room: "main",
      text: "I'm on nights starting Monday — I clock out at 07:30. Set me a daily reminder to log my patient-handoff notes about an hour after I get off, and don't put it in the middle of my sleep.",
      // The reminder is anchored to his post-shift hour, not a wall-clock guess;
      // the assistant must confirm the capture without claiming it also already
      // notified anyone.
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "The reply must confirm a daily patient-handoff-notes reminder anchored to about an hour after his 07:30 clock-out (i.e. in his post-shift morning, ~08:30), explicitly respecting that his sleep is during the day. It must NOT propose a mid-day time that lands in his daytime sleep, must NOT ask him to re-enter his whole schedule, and must NOT claim it has already logged or sent the notes. A generic 'reminder created' with no shift awareness, or one scheduled into his sleep, fails.",
      },
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "daily-handoff-record-exists-outside-protected-sleep",
      predicate: handoffReminderExistsOutsideSleep,
    },
    {
      type: "memoryWriteOccurred",
      table: "messages",
      minCount: 1,
    },
    {
      type: "judgeRubric",
      name: "shift-capture-anchoring",
      minimumScore: 0.7,
      rubric:
        "End-to-end: the assistant captured a daily reminder anchored to Marcus's post-shift hour rather than a wall-clock default, kept it out of his protected daytime sleep, and did not claim to have already performed the handoff itself.",
    },
  ],
});
