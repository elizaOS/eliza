/**
 * Shared drive-and-assert helpers for the first-run onboarding journey
 * scenarios (fast-start + customize → first reminder).
 *
 * First-run is NOT model-invocable: the live chat's onboarding conductor drives
 * `FirstRunService` directly (there is no planner action the model can select),
 * and the affordance only reaches the model through `firstRunProvider`. So the
 * scenarios split the proof: their live message turns exercise the model with
 * the onboarding affordance surfaced (recorded trajectory evidence), while these
 * helpers own pass/fail by driving the real `FirstRunService` through the same
 * path the conductor would — using the PRODUCTION scheduled-task runner so
 * seeded records land in the real `app_lifeops.life_scheduled_tasks` store —
 * then asserting that store (via `LifeOpsRepository`), never reply text.
 *
 * Precondition: `createScenarioRuntime` force-marks first-run `complete` (so the
 * provider stays quiet for unrelated scenarios). `resetFirstRunPrecondition`
 * runs as a seed step to restore the fresh-boot `pending` state these scenarios
 * require, so the provider surfaces during the turns and the service can be
 * walked from scratch in the final check.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { LifeOpsRepository } from "@elizaos/plugin-personal-assistant";
import {
  DEFAULT_PACK_IDEMPOTENCY_KEYS,
  deriveMorningWindow,
  parseWakeTime,
} from "@elizaos/plugin-personal-assistant/lifeops/first-run/defaults";
import { validateChannel } from "@elizaos/plugin-personal-assistant/lifeops/first-run/questions";
import {
  FirstRunService,
  type ScheduledTaskRunnerLike,
} from "@elizaos/plugin-personal-assistant/lifeops/first-run/service";
import { getScheduledTaskRunner } from "@elizaos/plugin-personal-assistant/lifeops/scheduled-task/service";
import type { ScheduledTask } from "@elizaos/plugin-scheduling";
import type { ScenarioContext } from "@elizaos/scenario-runner/schema";

function asRuntime(ctx: ScenarioContext): IAgentRuntime {
  return ctx.runtime as IAgentRuntime;
}

function agentIdOf(runtime: IAgentRuntime): string {
  return String(runtime.agentId ?? "");
}

/**
 * Build a `FirstRunService` bound to the PRODUCTION runner so scheduled records
 * are upserted into the DB-backed store (readable by `LifeOpsRepository`),
 * exactly as the boot seeder / conductor path does. `getScheduledTaskRunner`
 * throws when `@elizaos/plugin-scheduling` is not registered — that is a real
 * wiring failure the scenario should surface, not mask.
 */
function productionFirstRunService(runtime: IAgentRuntime): FirstRunService {
  const runner = getScheduledTaskRunner(runtime, {
    agentId: agentIdOf(runtime),
  }) as unknown as ScheduledTaskRunnerLike;
  return new FirstRunService(runtime, { runner });
}

function repoOf(runtime: IAgentRuntime): LifeOpsRepository {
  return new LifeOpsRepository(
    runtime as unknown as ConstructorParameters<typeof LifeOpsRepository>[0],
  );
}

async function readFirstRunTasks(
  runtime: IAgentRuntime,
): Promise<ScheduledTask[]> {
  const tasks = await repoOf(runtime).listScheduledTasks(agentIdOf(runtime), {
    source: "first_run",
  });
  return tasks;
}

function taskByKey(
  tasks: ScheduledTask[],
  idempotencyKey: string,
): ScheduledTask | undefined {
  return tasks.find(
    (t) => (t as { idempotencyKey?: string }).idempotencyKey === idempotencyKey,
  );
}

/** Cron minute+hour a `cronAtLocal(hhmm, tz)` trigger encodes, or null. */
function cronHourMinute(
  task: ScheduledTask | undefined,
): { minute: number; hour: number } | null {
  const trigger = task?.trigger;
  if (trigger?.kind !== "cron") return null;
  const parts = trigger.expression.trim().split(/\s+/);
  if (parts.length < 2) return null;
  const minute = Number.parseInt(parts[0], 10);
  const hour = Number.parseInt(parts[1], 10);
  if (!Number.isFinite(minute) || !Number.isFinite(hour)) return null;
  return { minute, hour };
}

/**
 * Assert the seeded default pack materialized in the real store and that the
 * gm reminder's cron is DERIVED from the answered wake time (outcome, not
 * routing). Returns an error string on the first failure, else undefined.
 */
function assertDefaultPackAnchoredToWake(
  tasks: ScheduledTask[],
  answeredWake: string,
): string | undefined {
  const wakeHHMM = parseWakeTime(answeredWake);
  if (!wakeHHMM) {
    return `test bug: wake time "${answeredWake}" did not parse`;
  }
  const morning = deriveMorningWindow(wakeHHMM);
  const [wakeHour, wakeMinute] = morning.startLocal
    .split(":")
    .map((p) => Number.parseInt(p, 10));

  const gm = taskByKey(tasks, DEFAULT_PACK_IDEMPOTENCY_KEYS.gm);
  const gn = taskByKey(tasks, DEFAULT_PACK_IDEMPOTENCY_KEYS.gn);
  const checkin = taskByKey(tasks, DEFAULT_PACK_IDEMPOTENCY_KEYS.checkin);
  const morningBrief = taskByKey(
    tasks,
    DEFAULT_PACK_IDEMPOTENCY_KEYS.morningBrief,
  );
  if (!gm || !gn || !checkin || !morningBrief) {
    return (
      `expected the seeded first-run default pack (gm/gn/checkin/morningBrief) ` +
      `in the scheduled-task store; saw idempotency keys ` +
      `[${tasks
        .map((t) => (t as { idempotencyKey?: string }).idempotencyKey ?? "?")
        .join(", ")}]`
    );
  }

  const gmAnchor = cronHourMinute(gm);
  if (!gmAnchor) {
    return `gm reminder is not a cron trigger: ${JSON.stringify(gm.trigger)}`;
  }
  if (gmAnchor.hour !== wakeHour || gmAnchor.minute !== wakeMinute) {
    return (
      `gm cron must be anchored to the answered wake time ` +
      `${morning.startLocal} (→ "${wakeMinute} ${wakeHour} * * *"), saw ` +
      `"${(gm.trigger as { expression?: string }).expression}"`
    );
  }

  if (checkin.kind !== "checkin") {
    return `check-in record has wrong kind: ${checkin.kind}`;
  }
  // The morning brief fires off the wake CONFIRMATION anchor, not a clock time.
  if (morningBrief.trigger.kind !== "relative_to_anchor") {
    return `morning brief must be wake-anchored, saw ${JSON.stringify(morningBrief.trigger)}`;
  }
  if (morningBrief.trigger.anchorKey !== "wake.confirmed") {
    return `morning brief anchor must be wake.confirmed, saw ${morningBrief.trigger.anchorKey}`;
  }
  const gnAnchor = cronHourMinute(gn);
  if (gnAnchor?.hour !== 22 || gnAnchor?.minute !== 0) {
    return `gn reminder must fire at 22:00 local, saw ${JSON.stringify(gn.trigger)}`;
  }
  return undefined;
}

/**
 * Seed step: restore the fresh-boot `pending` first-run state the harness
 * overwrote to `complete`. Also clears the seeded-defaults marker so the
 * scenario's drive schedules the pack from scratch.
 */
export async function resetFirstRunPrecondition(
  ctx: ScenarioContext,
): Promise<string | undefined> {
  const runtime = asRuntime(ctx);
  await new FirstRunService(runtime).resetState();
  const record = await new FirstRunService(runtime).readState();
  if (record.status !== "pending") {
    return `first-run precondition reset failed: status is ${record.status}`;
  }
  return undefined;
}

/**
 * Fast-start (defaults) outcome: one wake-time question, then the default pack
 * materializes with anchors derived from the answer. `answeredWake` is the
 * free-text wake time the owner gives (e.g. "6:30am").
 */
export function fastStartSeedsFirstReminder(
  answeredWake: string,
): (ctx: ScenarioContext) => Promise<string | undefined> {
  return async (ctx: ScenarioContext) => {
    const runtime = asRuntime(ctx);
    const service = productionFirstRunService(runtime);

    const ask = await service.runDefaultsPath({});
    if (
      ask.status !== "needs_more_input" ||
      ask.awaitingQuestion !== "wakeTime"
    ) {
      return `fast-start must ask wake time first, saw ${ask.status}/${ask.awaitingQuestion}`;
    }

    const done = await service.runDefaultsPath({ wakeTime: answeredWake });
    if (done.status !== "ok") {
      return `fast-start did not complete, saw ${done.status} (${done.message})`;
    }
    if (done.scheduledTasks.length === 0) {
      return "fast-start completed but scheduled no tasks";
    }

    const tasks = await readFirstRunTasks(runtime);
    return assertDefaultPackAnchoredToWake(tasks, answeredWake);
  };
}

/**
 * Full customize walk incl. the conditional relationships question (Q5 fires
 * only because `follow-ups` is among the categories), then assert the default
 * pack seeded with anchors derived from the answered morning window and that
 * the preferred name persisted.
 */
export async function customizeFullWalkSeedsReminders(
  ctx: ScenarioContext,
): Promise<string | undefined> {
  const runtime = asRuntime(ctx);
  const service = productionFirstRunService(runtime);

  const q1 = await service.runCustomizePath({});
  if (q1.awaitingQuestion !== "preferredName") {
    return `expected Q1 preferredName, saw ${q1.awaitingQuestion}`;
  }
  const q2 = await service.runCustomizePath({ preferredName: "Sam" });
  if (q2.awaitingQuestion !== "timezoneAndWindows") {
    return `expected Q2 timezoneAndWindows, saw ${q2.awaitingQuestion}`;
  }
  const q3 = await service.runCustomizePath({
    timezone: "America/Los_Angeles",
    morningWindow: { startLocal: "06:30", endLocal: "11:30" },
    eveningWindow: { startLocal: "18:00", endLocal: "22:00" },
  });
  if (q3.awaitingQuestion !== "categories") {
    return `expected Q3 categories, saw ${q3.awaitingQuestion}`;
  }
  const q4 = await service.runCustomizePath({
    categories: ["reminder packs", "follow-ups"],
  });
  if (q4.awaitingQuestion !== "channel") {
    return `expected Q4 channel, saw ${q4.awaitingQuestion}`;
  }
  // follow-ups selected → the conditional relationships question MUST fire.
  const q5 = await service.runCustomizePath({ channel: "in_app" });
  if (q5.awaitingQuestion !== "relationships") {
    return `follow-ups selected but Q5 relationships was skipped (saw ${q5.awaitingQuestion})`;
  }
  const done = await service.runCustomizePath({
    relationships: [
      { name: "Alice", cadenceDays: 14 },
      { name: "Bob", cadenceDays: 30 },
    ],
  });
  if (done.status !== "ok") {
    return `customize did not complete, saw ${done.status} (${done.message})`;
  }
  if (done.facts.preferredName !== "Sam") {
    return `preferred name not persisted, saw ${done.facts.preferredName}`;
  }

  const tasks = await readFirstRunTasks(runtime);
  // Morning window start 06:30 is the wake anchor for the customize path.
  return assertDefaultPackAnchoredToWake(tasks, "06:30");
}

/**
 * Abandon-mid-customize → resume without data loss. Answers Q1+Q2, abandons,
 * then a FRESH service instance (same runtime cache) resumes: it must advance
 * to the next UNanswered question (categories) rather than re-ask Q1/Q2, and
 * the persisted answers must survive. Exercises `FirstRunStateStore` durability.
 */
export async function abandonResumeNoDataLoss(
  ctx: ScenarioContext,
): Promise<string | undefined> {
  const runtime = asRuntime(ctx);
  const first = productionFirstRunService(runtime);

  const a1 = await first.runCustomizePath({ preferredName: "Riley" });
  if (a1.awaitingQuestion !== "timezoneAndWindows") {
    return `expected timezoneAndWindows after name, saw ${a1.awaitingQuestion}`;
  }
  const a2 = await first.runCustomizePath({
    timezone: "America/Chicago",
    morningWindow: { startLocal: "07:00", endLocal: "12:00" },
    eveningWindow: { startLocal: "19:00", endLocal: "23:00" },
  });
  if (a2.awaitingQuestion !== "categories") {
    return `expected categories after timezone, saw ${a2.awaitingQuestion}`;
  }

  // Abandon: the owner walks away mid-flow. State persists (in_progress).
  const state = await first.readState();
  if (state.status !== "in_progress") {
    return `expected in_progress after partial answers, saw ${state.status}`;
  }
  if (state.partialAnswers.preferredName !== "Riley") {
    return `Q1 answer lost from partialAnswers before resume`;
  }

  // Resume on a fresh instance with NO new input: it must NOT re-ask an
  // already-answered question — it advances to the first unanswered one.
  const resumed = productionFirstRunService(runtime);
  const r = await resumed.runCustomizePath({});
  if (r.awaitingQuestion !== "categories") {
    return (
      `resume re-asked an already-answered question — expected to resume at ` +
      `categories, saw ${r.awaitingQuestion}`
    );
  }

  // Finish the flow to prove resume reaches a real seeded first reminder.
  const c = await resumed.runCustomizePath({ categories: ["reminder packs"] });
  if (c.awaitingQuestion !== "channel") {
    return `expected channel after categories, saw ${c.awaitingQuestion}`;
  }
  const done = await resumed.runCustomizePath({ channel: "in_app" });
  if (done.status !== "ok") {
    return `resumed customize did not complete, saw ${done.status}`;
  }
  if (done.facts.preferredName !== "Riley") {
    return `preferred name lost across resume, saw ${done.facts.preferredName}`;
  }

  const tasks = await readFirstRunTasks(runtime);
  // Morning window start 07:00 was answered before the abandon.
  return assertDefaultPackAnchoredToWake(tasks, "07:00");
}

/**
 * Channel answer for a channel with no connected dispatcher → recorded with
 * `fallbackToInApp: true` and the warning surfaced. Asserts both the raw
 * validator contract and that the surfaced first-run result carries the
 * fallback warning + "(fallback)" completion message.
 */
export async function channelFallbackRecorded(
  ctx: ScenarioContext,
): Promise<string | undefined> {
  const runtime = asRuntime(ctx);

  const validation = await validateChannel("telegram", runtime);
  if (validation.fallbackToInApp !== true) {
    return `unconnected telegram must fall back to in-app, saw ${JSON.stringify(validation)}`;
  }
  if (!validation.warning || !/fall.?back|in-?app/i.test(validation.warning)) {
    return `expected a fallback warning, saw ${JSON.stringify(validation.warning)}`;
  }

  const service = productionFirstRunService(runtime);
  await service.runCustomizePath({ preferredName: "Jordan" });
  await service.runCustomizePath({
    timezone: "UTC",
    morningWindow: { startLocal: "06:00", endLocal: "11:00" },
    eveningWindow: { startLocal: "18:00", endLocal: "22:00" },
  });
  await service.runCustomizePath({ categories: ["reminder packs"] });
  const done = await service.runCustomizePath({ channel: "telegram" });
  if (done.status !== "ok") {
    return `customize with fallback channel did not complete, saw ${done.status}`;
  }
  if (
    done.warnings.length === 0 ||
    !done.warnings.some((w) => /fall.?back|in-?app/i.test(w))
  ) {
    return `fallback warning not surfaced on the first-run result, saw ${JSON.stringify(done.warnings)}`;
  }
  if (!/\(fallback\)/.test(done.message)) {
    return `completion message must mark the channel fallback, saw ${done.message}`;
  }

  const tasks = await readFirstRunTasks(runtime);
  if (tasks.length === 0) {
    return "fallback-channel customize seeded no scheduled tasks";
  }
  return undefined;
}
