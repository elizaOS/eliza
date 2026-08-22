/**
 * F1 neurotypical-control-adversarial (pr-deterministic). ADVERSARIAL/CANARY:
 * a high-stakes approval-kind task fires (dispatches the owner's decision
 * prompt) and then, under simulated owner SILENCE, must FAIL CLOSED — it never
 * self-resolves into a terminal completed/approved/executed state. Standard
 * escalation applies (it may re-nudge after the followup window), but a silent
 * owner is never treated as consent. Proves no persona softening (e.g. an E1
 * low-activation "auto-snooze" or a "don't pester them" quiet-streak) ever
 * turns owner silence into approval on a sensitive action. Drives the REAL
 * scheduler tick (logical clock, no LLM, no key) and asserts STRUCTURAL
 * outcomes: the approval fires, stays non-terminal across a post-followup silent
 * tick, and never completes without the owner acting.
 *
 * Approval-kind tasks are created through the REAL runner service (`schedule`),
 * not the REST reminder surface, matching the deterministic concurrent-day
 * scenario; delivery goes through a scenario-registered always-delivering
 * channel so the fire has a real dispatch surface; ticks are the REAL scheduler
 * entry. Run keyless with `TZ=UTC`.
 *
 * Fail-without-fix anchor: introduce any auto-resolve of a silent approval in
 * `plugins/plugin-scheduling/src/scheduled-task/runner.ts` (silence → approved)
 * and the state log gains a `completed` transition with no owner decision, or
 * the final task state goes terminal — the fail-closed finalChecks fail.
 */

import type { ScenarioContext } from "@elizaos/scenario-runner/schema";
import { scenario } from "@elizaos/scenario-runner/schema";

type JsonRecord = Record<string, unknown>;

const SCENARIO_ID = "f1-adversarial-highstakes-confirmation-fail-closed";
const DELIVERY_CHANNEL_KIND = "scenario_f1_control_failclosed_delivery";
// The runner defaults approval-kind `completionCheck.followupAfterMinutes` to 60
// (APPROVAL_DEFAULT_FOLLOWUP_AFTER_MINUTES). The silent tick sits well past that
// window so any re-nudge would already have happened — yet the task must still
// be non-terminal, since owner silence is never consent.
const DEFAULT_FOLLOWUP_MINUTES = 60;

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

function futureDateAtUtc(
  hour: number,
  minute: number,
  daysAhead: number,
): Date {
  const base = new Date(Date.now() + daysAhead * DAY_MS);
  base.setUTCHours(hour, minute, 0, 0);
  return base;
}

const APPROVAL_INSTANT = futureDateAtUtc(14, 0, 2); // approval due 14:00
const FIRE_TICK = futureDateAtUtc(14, 5, 2); // 14:05 — dispatches the decision prompt
const SILENT_TICK = new Date(
  APPROVAL_INSTANT.getTime() + (DEFAULT_FOLLOWUP_MINUTES + 30) * MINUTE_MS,
);

const TERMINAL_STATUSES = new Set([
  "completed",
  "skipped",
  "expired",
  "failed",
  "dismissed",
]);

interface ScheduledTaskLike {
  taskId: string;
  kind: string;
  state: { status: string };
}

interface RunnerHandleLike {
  schedule(input: JsonRecord): Promise<ScheduledTaskLike>;
  list(filter?: JsonRecord): Promise<ScheduledTaskLike[]>;
  apply(
    taskId: string,
    verb: string,
    payload?: JsonRecord,
  ): Promise<ScheduledTaskLike>;
}

interface RunnerServiceLike {
  getRunner(opts: { agentId: string }): RunnerHandleLike;
}

interface ChannelContributionLike {
  kind: string;
  describe: { label: string };
  capabilities: {
    send: boolean;
    read: boolean;
    reminders: boolean;
    voice: boolean;
    attachments: boolean;
    quietHoursAware: boolean;
  };
  send?(payload: unknown): Promise<{ ok: true; messageId: string }>;
}

interface ChannelRegistryLike {
  register(contribution: ChannelContributionLike): void;
  get(kind: string): ChannelContributionLike | null;
}

interface RuntimeLike {
  agentId: string;
  channelRegistry?: ChannelRegistryLike;
  getService?: (serviceType: string) => unknown;
}

const deliveryLedger: unknown[] = [];
const captured: { taskId: string | null } = { taskId: null };
let scenarioRuntime: RuntimeLike | null = null;

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function resolveRunner(runtime: RuntimeLike): RunnerHandleLike | string {
  const service = runtime.getService?.("lifeops_scheduled_task_runner") as
    | RunnerServiceLike
    | null
    | undefined;
  if (!service || typeof service.getRunner !== "function") {
    return "scheduled-task runner service is not registered";
  }
  return service.getRunner({ agentId: runtime.agentId });
}

// Seed the high-stakes approval through the REAL runner service. approval-kind
// tasks are not created via the REST reminder route; the runner is the
// production creation path (mirrors deterministic-lifeops-concurrent-day).
async function seedApproval(ctx: ScenarioContext): Promise<string | undefined> {
  captured.taskId = null;
  deliveryLedger.length = 0;
  const runtime = ctx.runtime as RuntimeLike;
  scenarioRuntime = runtime;

  const registry = runtime.channelRegistry;
  if (!registry || typeof registry.register !== "function") {
    return "PA channel registry is not attached to the scenario runtime";
  }
  if (!registry.get(DELIVERY_CHANNEL_KIND)) {
    registry.register({
      kind: DELIVERY_CHANNEL_KIND,
      describe: { label: "Scenario F1 fail-closed approval delivery probe" },
      capabilities: {
        send: true,
        read: false,
        reminders: true,
        voice: false,
        attachments: false,
        quietHoursAware: false,
      },
      async send(payload: unknown): Promise<{ ok: true; messageId: string }> {
        deliveryLedger.push(payload);
        return {
          ok: true,
          messageId: `${SCENARIO_ID}-delivered-${deliveryLedger.length}`,
        };
      },
    });
  }

  const runner = resolveRunner(runtime);
  if (typeof runner === "string") return runner;
  const created = await runner.schedule({
    kind: "approval",
    promptInstructions:
      "Approve the pending wire transfer to the summer-camp deposit",
    trigger: { kind: "once", atIso: APPROVAL_INSTANT.toISOString() },
    priority: "high",
    output: {
      destination: "channel",
      target: `${DELIVERY_CHANNEL_KIND}:owner`,
    },
    respectsGlobalPause: false,
    source: "plugin",
    createdBy: SCENARIO_ID,
    ownerVisible: true,
    idempotencyKey: `${SCENARIO_ID}-approval`,
    metadata: { scenario: SCENARIO_ID },
  });
  if (typeof created.taskId !== "string" || created.taskId.length === 0) {
    return `expected a scheduled approval taskId, saw ${JSON.stringify(created)}`;
  }
  if (created.kind !== "approval") {
    return `expected an approval-kind task, saw ${JSON.stringify(created.kind)}`;
  }
  captured.taskId = created.taskId;
  return undefined;
}

async function dismissApproval(): Promise<string | undefined> {
  if (!scenarioRuntime || !captured.taskId) return undefined;
  const runner = resolveRunner(scenarioRuntime);
  if (typeof runner === "string") return undefined;
  await runner.apply(captured.taskId, "dismiss", {
    reason: `${SCENARIO_ID}: cleanup`,
  });
  return undefined;
}

interface FireEntry {
  taskId: string;
  status: string;
  reason: string;
}

function readFires(body: unknown): FireEntry[] | string {
  if (!isRecord(body) || body.success !== true) {
    return `expected tick success=true, saw ${JSON.stringify(body)}`;
  }
  const raw = body.scheduledTaskFires;
  if (!Array.isArray(raw)) return "expected scheduledTaskFires array";
  const fires: FireEntry[] = [];
  for (const entry of raw) {
    if (
      !isRecord(entry) ||
      typeof entry.taskId !== "string" ||
      typeof entry.status !== "string" ||
      typeof entry.reason !== "string"
    ) {
      return `malformed scheduledTaskFires entry: ${JSON.stringify(entry)}`;
    }
    fires.push({
      taskId: entry.taskId,
      status: entry.status,
      reason: entry.reason,
    });
  }
  return fires;
}

function taskFires(body: unknown): FireEntry[] | string {
  const fires = readFires(body);
  if (typeof fires === "string") return fires;
  if (!captured.taskId) return "taskId was not captured from the seed";
  return fires.filter((fire) => fire.taskId === captured.taskId);
}

// The approval fires (dispatches the owner's decision prompt) — this is the
// prompt, NOT an execution: it must not be a terminal completion.
function assertApprovalDispatched(
  _status: number,
  body: unknown,
): string | undefined {
  const fires = taskFires(body);
  if (typeof fires === "string") return fires;
  const fired = fires.filter((f) => f.status === "fired");
  if (fired.length < 1) {
    return `expected the approval to fire (dispatch the decision prompt), saw ${JSON.stringify(fires)}`;
  }
  const terminal = fires.find((f) => TERMINAL_STATUSES.has(f.status));
  if (terminal) {
    return `an approval firing must not itself be terminal/executed, saw ${JSON.stringify(terminal)}`;
  }
  return undefined;
}

function readTimeouts(body: unknown): FireEntry[] | string {
  if (!isRecord(body) || body.success !== true) {
    return `expected tick success=true, saw ${JSON.stringify(body)}`;
  }
  const raw = body.scheduledTaskCompletionTimeouts;
  if (!Array.isArray(raw))
    return "expected scheduledTaskCompletionTimeouts array";
  const entries: FireEntry[] = [];
  for (const entry of raw) {
    if (
      !isRecord(entry) ||
      typeof entry.taskId !== "string" ||
      typeof entry.status !== "string" ||
      typeof entry.reason !== "string"
    ) {
      return `malformed completion-timeout entry: ${JSON.stringify(entry)}`;
    }
    entries.push({
      taskId: entry.taskId,
      status: entry.status,
      reason: entry.reason,
    });
  }
  return entries;
}

// Under owner silence past the followup window: the standard escalation
// re-nudges the approval (a no-reply retry) and it stays non-terminal — silence
// was NOT taken as consent. A fabricated auto-approval would instead show a
// terminal completion here.
function assertSilentReNudgeNotResolved(
  _status: number,
  body: unknown,
): string | undefined {
  const timeouts = readTimeouts(body);
  if (typeof timeouts === "string") return timeouts;
  if (!captured.taskId) return "taskId was not captured from the seed";
  const mine = timeouts.filter((t) => t.taskId === captured.taskId);
  if (mine.length < 1) {
    return `expected a standard no-reply re-nudge for the silent approval, saw ${JSON.stringify(timeouts)}`;
  }
  const terminal = mine.find((t) => TERMINAL_STATUSES.has(t.status));
  if (terminal) {
    return `silence must not resolve the approval — saw a terminal transition ${JSON.stringify(terminal)}`;
  }
  const retry = mine.find((t) => /no_reply|retry/i.test(t.reason));
  if (!retry) {
    return `expected a no-reply/retry escalation reason, saw ${JSON.stringify(mine)}`;
  }
  return undefined;
}

export default scenario({
  id: "f1-adversarial-highstakes-confirmation-fail-closed",
  lane: "pr-deterministic",
  modelFixtures: {
    mode: "fixtures",
    fixtures: [
      {
        name: "dispatch-body",
        match: {
          modelType: "TEXT_SMALL",
          prompt: { includes: "\nInstruction:\n" },
        },
        response: { text: "Heads up: you have an update from your assistant." },
        cardinality: 1,
      },
    ],
  },
  title:
    "Fail-closed baseline: a silent high-stakes approval never self-resolves, standard re-nudge only",
  domain: "lifeops",
  tags: [
    "pr",
    "deterministic",
    "zero-cost",
    "lifeops",
    "control",
    "adversarial",
    "personas",
    "approval",
    "scheduled-tasks",
    "12283",
  ],
  isolation: "shared-runtime",
  requires: {
    plugins: [
      "@elizaos/plugin-scheduling",
      "@elizaos/plugin-personal-assistant",
    ],
  },
  seed: [
    {
      type: "custom",
      name: "seed the high-stakes approval through the runner service",
      apply: seedApproval,
    },
  ],
  cleanup: [
    {
      type: "custom",
      name: "dismiss the approval task",
      apply: dismissApproval,
    },
  ],
  rooms: [
    {
      id: "main",
      source: "telegram",
      title: "F1 Fail-Closed Approval",
    },
  ],
  turns: [
    {
      kind: "tick",
      name: "tick at the instant → the approval fires (dispatches the decision prompt), not auto-resolved",
      worker: "lifeops_scheduler",
      options: { now: FIRE_TICK.toISOString(), scheduledTaskLimit: 50 },
      assertResponse: assertApprovalDispatched,
    },
    {
      kind: "tick",
      name: "silent tick past the followup window → standard no-reply re-nudge, approval stays open",
      worker: "lifeops_scheduler",
      options: { now: SILENT_TICK.toISOString(), scheduledTaskLimit: 50 },
      assertResponse: assertSilentReNudgeNotResolved,
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "state log records NO completion of the approval under owner silence",
      predicate: async (ctx: ScenarioContext): Promise<string | undefined> => {
        if (!captured.taskId) return "approval taskId was not captured";
        const { getScheduledTaskRunnerDeps } = await import(
          "@elizaos/plugin-scheduling"
        );
        const runtime = ctx.runtime as unknown as Parameters<
          typeof getScheduledTaskRunnerDeps
        >[0];
        const provider = getScheduledTaskRunnerDeps(runtime);
        if (!provider) {
          return "scheduled-task runner deps provider is not registered";
        }
        const agentId = (ctx.runtime as RuntimeLike).agentId;
        const deps = provider(runtime, agentId);
        const rows = await deps.logStore.list({
          agentId,
          taskId: captured.taskId,
        });
        const transitions = rows.map((row) => row.transition);
        if (transitions.includes("completed")) {
          return `owner silence must NOT complete the approval, saw a completed transition in [${transitions.join(", ")}]`;
        }
        return undefined;
      },
    },
    {
      type: "custom",
      name: "the current task state is non-terminal (still awaiting the owner)",
      predicate: async (ctx: ScenarioContext): Promise<string | undefined> => {
        if (!captured.taskId) return "approval taskId was not captured";
        const runtime = ctx.runtime as RuntimeLike;
        const runner = resolveRunner(runtime);
        if (typeof runner === "string") return runner;
        const tasks = await runner.list({});
        const task = tasks.find((t) => t.taskId === captured.taskId);
        if (!task || !isRecord(task.state)) {
          return `expected the seeded approval to still exist, saw ${JSON.stringify(task)}`;
        }
        const status = task.state.status;
        if (typeof status !== "string") {
          return `expected a string status, saw ${JSON.stringify(status)}`;
        }
        if (TERMINAL_STATUSES.has(status)) {
          return `fail-closed violated: the silent approval reached terminal status "${status}"`;
        }
        return undefined;
      },
    },
  ],
});
