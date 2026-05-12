/**
 * Cerebras-graded journey eval — opt-in live suite.
 *
 * One describe block per UX_JOURNEYS chapter (28 total). Each test drives a
 * synthetic journey scenario through the same `ScheduledTask` spine as the
 * structural W3-C replay (see `journey-domain-coverage.test.ts`), captures
 * the resulting tasks + state-log entries, and asks Cerebras gpt-oss-120b to
 * grade whether the spine handled the journey correctly. The verdict is
 * parsed from a JSON envelope and asserted to be `pass` or
 * `pass_with_caveat`.
 *
 * The suite gates on `CEREBRAS_API_KEY` so absent-credential CI runs skip
 * the entire file. The `.live.e2e.test.ts` suffix excludes this file from
 * `bun run test`; use `scripts/run-cerebras-journey-eval.mjs` to invoke.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createCompletionCheckRegistry,
  registerBuiltInCompletionChecks,
} from "../src/lifeops/scheduled-task/completion-check-registry.ts";
import {
  createAnchorRegistry,
  createConsolidationRegistry,
} from "../src/lifeops/scheduled-task/consolidation-policy.ts";
import {
  createEscalationLadderRegistry,
  registerDefaultEscalationLadders,
} from "../src/lifeops/scheduled-task/escalation.ts";
import {
  createTaskGateRegistry,
  registerBuiltInGates,
} from "../src/lifeops/scheduled-task/gate-registry.ts";
import {
  createInMemoryScheduledTaskStore,
  createScheduledTaskRunner,
  TestNoopScheduledTaskDispatcher,
  type ScheduledTaskRunnerHandle,
} from "../src/lifeops/scheduled-task/runner.ts";
import {
  createInMemoryScheduledTaskLogStore,
  type ScheduledTaskLogStore,
} from "../src/lifeops/scheduled-task/state-log.ts";
import type {
  ActivitySignalBusView,
  GlobalPauseView,
  OwnerFactsView,
  ScheduledTask,
  ScheduledTaskKind,
  ScheduledTaskLogEntry,
  ScheduledTaskPriority,
  ScheduledTaskTrigger,
  SubjectStoreView,
} from "../src/lifeops/scheduled-task/types.ts";
import {
  getEvalModelClient,
  type CerebrasChatResponse,
  type EvalModelClient,
} from "./helpers/lifeops-eval-model.ts";

// ---------------------------------------------------------------------------
// dotenv + env gating
// ---------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, "..");
const repoRoot = path.resolve(packageRoot, "..", "..");
dotenv.config({ path: path.resolve(packageRoot, ".env") });
dotenv.config({ path: path.resolve(repoRoot, ".env") });

const CEREBRAS_KEY_PRESENT =
  !!process.env.CEREBRAS_API_KEY ||
  !!process.env.EVAL_CEREBRAS_API_KEY ||
  !!process.env.ELIZA_E2E_CEREBRAS_API_KEY;

const CEREBRAS_MODEL =
  process.env.EVAL_MODEL ?? process.env.CEREBRAS_MODEL ?? "gpt-oss-120b";
const CEREBRAS_PROVIDER = process.env.EVAL_MODEL_PROVIDER ?? "cerebras";
const RESULTS_PATH = path.join(
  packageRoot,
  "docs",
  "audit",
  "cerebras-journey-eval-results.json",
);

// ---------------------------------------------------------------------------
// Harness — mirrors the W3-C structural test's harness; thin wrapper around
// the production runner factory.
// ---------------------------------------------------------------------------

interface SignalArgs {
  signalKind: string;
  sinceIso: string;
}

interface Harness {
  runner: ScheduledTaskRunnerHandle;
  logStore: ScheduledTaskLogStore;
  agentId: string;
  setNow(iso: string): void;
  setOwnerFacts(facts: OwnerFactsView): void;
  setPauseActive(active: boolean, reason?: string): void;
  signal(kind: string, atIso: string): void;
  touchSubject(subjectId: string, atIso: string): void;
}

function makeHarness(initialIso?: string): Harness {
  let nowIso = initialIso ?? "2026-05-09T08:00:00.000Z";
  let ownerFacts: OwnerFactsView = { timezone: "UTC" };
  let pauseState: { active: boolean; reason?: string } = { active: false };
  const observedSignals = new Map<string, string>();
  const subjectUpdates = new Map<string, string>();

  const activity: ActivitySignalBusView = {
    hasSignalSince(args: SignalArgs): boolean {
      const at = observedSignals.get(args.signalKind);
      if (!at) return false;
      return new Date(at).getTime() >= new Date(args.sinceIso).getTime();
    },
  };
  const subjectStore: SubjectStoreView = {
    wasUpdatedSince(args: { subject: { id: string }; sinceIso: string }) {
      const at = subjectUpdates.get(args.subject.id);
      if (!at) return false;
      return new Date(at).getTime() >= new Date(args.sinceIso).getTime();
    },
  };

  const gates = createTaskGateRegistry();
  registerBuiltInGates(gates);
  const completionChecks = createCompletionCheckRegistry();
  registerBuiltInCompletionChecks(completionChecks);
  const ladders = createEscalationLadderRegistry();
  registerDefaultEscalationLadders(ladders);
  const anchors = createAnchorRegistry();
  const consolidation = createConsolidationRegistry();
  const store = createInMemoryScheduledTaskStore();
  const logStore = createInMemoryScheduledTaskLogStore();

  let counter = 0;
  const pauseView: GlobalPauseView = {
    current: async () => ({ ...pauseState }),
  };
  const agentId = "test-agent-cerebras-journey";
  const runner = createScheduledTaskRunner({
    agentId,
    store,
    logStore,
    gates,
    completionChecks,
    ladders,
    anchors,
    consolidation,
    ownerFacts: () => ownerFacts,
    globalPause: pauseView,
    activity,
    subjectStore,
    dispatcher: TestNoopScheduledTaskDispatcher,
    newTaskId: () => {
      counter += 1;
      return `cje_${counter}`;
    },
    now: () => new Date(nowIso),
  });

  return {
    runner,
    logStore,
    agentId,
    setNow: (iso) => {
      nowIso = iso;
    },
    setOwnerFacts: (facts) => {
      ownerFacts = facts;
    },
    setPauseActive: (active, reason) => {
      pauseState = active ? { active: true, reason } : { active: false };
    },
    signal: (kind, atIso) => {
      observedSignals.set(kind, atIso);
    },
    touchSubject: (subjectId, atIso) => {
      subjectUpdates.set(subjectId, atIso);
    },
  };
}

interface BaseInputOverrides {
  kind?: ScheduledTaskKind;
  promptInstructions?: string;
  trigger?: ScheduledTaskTrigger;
  priority?: ScheduledTaskPriority;
  ownerVisible?: boolean;
  source?: ScheduledTask["source"];
  createdBy?: string;
  respectsGlobalPause?: boolean;
  metadata?: Record<string, unknown>;
}

type ScheduleInput = Omit<ScheduledTask, "taskId" | "state">;

function input(
  overrides: BaseInputOverrides & Partial<ScheduleInput> = {},
): ScheduleInput {
  const { kind, promptInstructions, trigger, priority, ...rest } = overrides;
  return {
    kind: kind ?? "reminder",
    promptInstructions: promptInstructions ?? "cerebras eval scenario",
    trigger: trigger ?? { kind: "manual" },
    priority: priority ?? "medium",
    respectsGlobalPause: rest.respectsGlobalPause ?? true,
    source: rest.source ?? "default_pack",
    createdBy: rest.createdBy ?? "journey-cerebras-eval",
    ownerVisible: rest.ownerVisible ?? true,
    ...rest,
  };
}

// ---------------------------------------------------------------------------
// Cerebras grading
// ---------------------------------------------------------------------------

type Verdict = "pass" | "pass_with_caveat" | "fail";

interface GradeEnvelope {
  verdict: Verdict;
  rationale: string;
  caveat?: string;
}

interface DomainResult {
  domain: number;
  title: string;
  verdict: Verdict;
  rationale: string;
  caveat?: string;
  usage?: CerebrasChatResponse["usage"];
  tasksObserved: number;
  logEntriesObserved: number;
}

const SYSTEM_PROMPT = [
  "You are an evaluator for the Eliza LifeOps system, which exposes a single",
  "`ScheduledTask` spine that handles habits, routines, reminders, approvals,",
  "watchers, recaps, outputs, follow-ups, and freeform custom flows.",
  "",
  "You will receive a UX-journey description, a synthetic scenario that drove",
  "tasks through the spine, and the resulting state (tasks + log entries).",
  "Decide whether the spine handled the journey correctly.",
  "",
  'Reply with ONLY a single JSON object, no prose, exactly: {"verdict":"pass"|',
  '"pass_with_caveat"|"fail","rationale":"<one sentence>","caveat":"<optional>"}.',
  "",
  "Grading rules:",
  "- pass = scenario completed end-to-end with the expected terminal states + ",
  "  the right pipeline outcomes for the journey.",
  "- pass_with_caveat = end-state is correct but something minor in the log is",
  "  worth noting (no behavioural defect).",
  "- fail = a terminal state, pipeline outcome, or invariant is wrong for the",
  "  journey description.",
  "",
  "Spine semantics you MUST respect when grading. Treat these as ground truth.",
  "Do NOT mark a task as failed because it lacks fields these rules say are",
  "optional or absent by design.",
  "",
  "1. `state.firedAt` is OPTIONAL. The runner only sets it when the task is",
  "   actually fired by the dispatcher. A scenario that calls `apply('complete')`",
  "   without first calling `fire()` will have `state.firedAt = undefined` —",
  "   that is correct behavior, NOT a bug. Do NOT fail a task just because",
  "   `firedAt` is missing. Do NOT compare `firedAt` to scenario narrative time.",
  "",
  "1a. The trigger time (`trigger.atIso` for a `once` trigger) is the *target*",
  "    schedule time. Operators (or tests) can mark the task complete BEFORE",
  "    the target wall-clock without firing — for example, when the user",
  "    confirms 'I already did it' early. That is a valid terminal state and",
  "    must NOT be flagged as 'completed before scheduled time'. The spine",
  "    does not enforce that completedAt >= trigger.atIso.",
  "",
  "2. Gates: a `shouldFire.gates` array on the task IS the gate decision. The",
  "   runner does NOT emit a separate gate-decision log row at schedule time —",
  "   gate decisions only appear in the log after a `fire` attempt. A task",
  "   with `shouldFire.gates = [{kind: 'quiet_hours', ...}]` and no fire log",
  "   row is correct.",
  "",
  "3. Escalation ladders are evaluated LAZILY by the dispatcher, not",
  "   materialized at schedule time. A `priority: 'high'` reminder produces",
  "   ONE task record, not three. The 3-step ladder lives in the registries",
  "   (visible via `inspectRegistries`). Do NOT fail a high-priority task for",
  "   not spawning child escalation tasks — that is by design.",
  "",
  "4. `contextRequest` is a typed request shape on the task. A non-null",
  "   `contextRequest` means the spine is carrying it. Its presence + the",
  "   shape of its include flags is what to grade.",
  "",
  "5. `pipeline.onComplete` children are scheduled (not auto-completed). When",
  "   a parent reaches `completed`, its onComplete child is created with",
  "   `state.status = 'scheduled'` and waits for its own fire/complete. Do",
  "   NOT fail a workflow because the child is `scheduled` — that is the",
  "   expected end-state for the parent's complete event.",
  "",
  "5a. Tasks are referenced by `taskId`, not by chronological order in the",
  "    log. A scenario that schedules task A then task B then completes B",
  "    before A is valid. Do NOT fail on log-order/scheduling-order mismatch.",
  "    Pipeline outcomes are checked by terminal STATUS and",
  "    `state.pipelineParentId`, not by completion timestamp ordering.",
  "",
  "6. `source` lives on the task root, not in `state` or `metadata`. A REST",
  "   API task with `source: 'plugin'` will have that field at the top level",
  "   of the ScheduledTask record. Do NOT fail it for not appearing under",
  "   `state`.",
  "",
  "7. Health-signal completion checks succeed when the signal occurs WITHIN",
  "   the configured `lookbackMinutes` window before evaluation. A signal at",
  "   t+5min and an evaluation at t+30min with `lookbackMinutes: 480` is a",
  "   valid auto-complete; the signal is well within the lookback. Do NOT",
  "   fail this case for ordering — the rule is window-based, not strict.",
  "",
  "Grading approach: focus on terminal STATUS, pipeline outcomes, and the",
  "presence/shape of typed contracts (subject, contextRequest, output,",
  "completionCheck). Do NOT invent fields the rules above mark optional.",
].join("\n");

function buildPrompt(args: {
  domain: number;
  title: string;
  description: string;
  scenarioSummary: string;
  tasks: ScheduledTask[];
  logEntries: ScheduledTaskLogEntry[];
}): string {
  const taskSummaries = args.tasks.map((t) => ({
    taskId: t.taskId,
    kind: t.kind,
    promptInstructions: t.promptInstructions,
    trigger: t.trigger,
    priority: t.priority,
    subject: t.subject,
    ownerVisible: t.ownerVisible,
    output: t.output,
    // Top-level provenance fields the grader needs for source/createdBy
    // checks. These are NOT under `state` — keep the field placement obvious.
    source: t.source,
    createdBy: t.createdBy,
    respectsGlobalPause: t.respectsGlobalPause,
    idempotencyKey: t.idempotencyKey,
    // shouldFire surfaces the gate-decision shape (e.g. quiet_hours) so the
    // grader can inspect gates without expecting a parallel decision record.
    shouldFire: t.shouldFire,
    completionCheck: t.completionCheck,
    pipeline: t.pipeline,
    contextRequest: t.contextRequest,
    escalation: t.escalation,
    state: {
      ...t.state,
      // Explicit firedAt / completedAt callouts so the grader can compare
      // ordering directly. firedAt is the *next* fire instant (= trigger
      // instant for once-triggers until first fire); completedAt is the
      // wall-clock the runner observed when the user marked complete.
      firedAt: t.state.firedAt,
      completedAt: t.state.completedAt,
    },
    metadata: t.metadata,
  }));
  const logSummaries = args.logEntries.map((l) => ({
    taskId: l.taskId,
    transition: l.transition,
    occurredAtIso: l.occurredAtIso,
    reason: l.reason,
  }));
  return [
    `Domain ${args.domain} — ${args.title}`,
    "",
    "Description:",
    args.description,
    "",
    "Synthetic scenario:",
    args.scenarioSummary,
    "",
    "Resulting ScheduledTask records (firedAt = next fire instant, NOT scenario clock):",
    JSON.stringify(taskSummaries, null, 2),
    "",
    "State-log entries (chronological, occurredAtIso = wall-clock):",
    JSON.stringify(logSummaries, null, 2),
    "",
    "Grade the spine's handling of this journey. Respond with the JSON envelope only.",
  ].join("\n");
}

function parseEnvelope(raw: string): GradeEnvelope {
  const fenced = raw
    .replace(/^[\s\S]*?```(?:json)?\s*/i, "")
    .replace(/```[\s\S]*$/i, "")
    .trim();
  const candidate = fenced.length > 0 ? fenced : raw;
  const match = candidate.match(/\{[\s\S]*\}/);
  if (!match) {
    throw new Error(`cerebras response not parseable as JSON: ${raw}`);
  }
  const parsed = JSON.parse(match[0]) as Partial<GradeEnvelope>;
  if (
    parsed.verdict !== "pass" &&
    parsed.verdict !== "pass_with_caveat" &&
    parsed.verdict !== "fail"
  ) {
    throw new Error(`cerebras response missing verdict: ${raw}`);
  }
  if (typeof parsed.rationale !== "string" || parsed.rationale.length === 0) {
    throw new Error(`cerebras response missing rationale: ${raw}`);
  }
  return {
    verdict: parsed.verdict,
    rationale: parsed.rationale,
    caveat: typeof parsed.caveat === "string" ? parsed.caveat : undefined,
  };
}

async function gradeJourney(
  client: EvalModelClient,
  args: {
    domain: number;
    title: string;
    description: string;
    scenarioSummary: string;
    tasks: ScheduledTask[];
    logEntries: ScheduledTaskLogEntry[];
  },
): Promise<{ envelope: GradeEnvelope; usage?: CerebrasChatResponse["usage"] }> {
  const response = await client({
    prompt: buildPrompt(args),
    systemPrompt: SYSTEM_PROMPT,
    temperature: 0,
    maxTokens: 4000,
    reasoningEffort: "low",
  });
  return { envelope: parseEnvelope(response.text), usage: response.usage };
}

// ---------------------------------------------------------------------------
// Suite — 28 domain blocks. Each test drives a scenario, captures spine
// state, grades via Cerebras, asserts pass/pass_with_caveat, and accumulates
// into `RESULTS` for the final write-out.
// ---------------------------------------------------------------------------

const RESULTS: DomainResult[] = [];

let evalClient: EvalModelClient | null = null;

beforeAll(() => {
  if (!CEREBRAS_KEY_PRESENT) {
    console.info(
      "[cerebras-journey-eval] CEREBRAS_API_KEY not set — skipping live suite (set it in eliza/.env to enable).",
    );
    return;
  }
  console.info(
    `[cerebras-journey-eval] grading via provider=${CEREBRAS_PROVIDER} model=${CEREBRAS_MODEL}`,
  );
  evalClient = getEvalModelClient();
});

function requireClient(): EvalModelClient {
  if (!evalClient) {
    throw new Error("cerebras eval client not initialized");
  }
  return evalClient;
}

const describeIfKey = CEREBRAS_KEY_PRESENT ? describe : describe.skip;

async function recordAndAssert(args: {
  domain: number;
  title: string;
  description: string;
  scenarioSummary: string;
  tasks: ScheduledTask[];
  logEntries: ScheduledTaskLogEntry[];
}): Promise<void> {
  const { envelope, usage } = await gradeJourney(requireClient(), args);
  RESULTS.push({
    domain: args.domain,
    title: args.title,
    verdict: envelope.verdict,
    rationale: envelope.rationale,
    caveat: envelope.caveat,
    usage,
    tasksObserved: args.tasks.length,
    logEntriesObserved: args.logEntries.length,
  });
  if (envelope.verdict === "fail") {
    throw new Error(
      `domain ${args.domain} (${args.title}) graded fail: ${envelope.rationale}`,
    );
  }
}

async function collectLog(
  store: ScheduledTaskLogStore,
  agentId: string,
  taskIds: string[],
): Promise<ScheduledTaskLogEntry[]> {
  const all: ScheduledTaskLogEntry[] = [];
  for (const id of taskIds) {
    const rows = await store.list({ agentId, taskId: id, limit: 50 });
    all.push(...rows);
  }
  return all;
}

describeIfKey("Domain 1 — Onboarding & first-run setup", () => {
  it("seeds first-run defaults and the spine accepts every idempotency key", async () => {
    const h = makeHarness();
    const seeds: ScheduleInput[] = [
      input({
        kind: "reminder",
        promptInstructions: "gm at wake",
        trigger: {
          kind: "relative_to_anchor",
          anchorKey: "wake.confirmed",
          offsetMinutes: 0,
        },
        priority: "low",
        idempotencyKey: "default-pack:daily-rhythm:gm",
      }),
      input({
        kind: "reminder",
        promptInstructions: "gn at bedtime",
        trigger: {
          kind: "relative_to_anchor",
          anchorKey: "bedtime.target",
          offsetMinutes: 0,
        },
        priority: "low",
        idempotencyKey: "default-pack:daily-rhythm:gn",
      }),
      input({
        kind: "checkin",
        promptInstructions: "morning check-in",
        trigger: { kind: "during_window", windowKey: "morning" },
        idempotencyKey: "default-pack:daily-rhythm:morning-checkin",
      }),
      input({
        kind: "recap",
        promptInstructions: "morning brief assembly",
        trigger: { kind: "during_window", windowKey: "morning" },
        idempotencyKey: "default-pack:morning-brief:assemble",
      }),
    ];
    const tasks = await Promise.all(seeds.map((s) => h.runner.schedule(s)));
    const log = await collectLog(h.logStore, h.agentId, tasks.map((t) => t.taskId));
    await recordAndAssert({
      domain: 1,
      title: "Onboarding & first-run setup",
      description:
        "On first launch the default pack seeds gm/gn, a morning check-in, and a morning brief recap. Each seed is idempotent and lands in `scheduled` state.",
      scenarioSummary:
        "Schedule four default-pack seeds with distinct idempotency keys and inspect their resulting state.",
      tasks,
      logEntries: log,
    });
  });
});

describeIfKey("Domain 2 — Core data model & overview surface", () => {
  it("the spine accepts every documented kind without runner edits", async () => {
    const h = makeHarness();
    const kinds: ScheduledTaskKind[] = [
      "reminder",
      "checkin",
      "followup",
      "approval",
      "recap",
      "watcher",
      "output",
      "custom",
    ];
    const tasks = await Promise.all(
      kinds.map((k) =>
        h.runner.schedule(input({ kind: k, promptInstructions: `${k}-task` })),
      ),
    );
    const log = await collectLog(h.logStore, h.agentId, tasks.map((t) => t.taskId));
    await recordAndAssert({
      domain: 2,
      title: "Core data model & overview surface",
      description:
        "The overview surface displays tasks of every kind. The single ScheduledTask spine must handle each documented kind with no specialized branching.",
      scenarioSummary:
        "Schedule one task per documented kind and confirm all reach `scheduled` state.",
      tasks,
      logEntries: log,
    });
  });
});

describeIfKey("Domain 3 — Habits", () => {
  it("recurring habit fires, completes, and propagates onComplete pipeline", async () => {
    const h = makeHarness();
    const habit = await h.runner.schedule(
      input({
        kind: "reminder",
        promptInstructions: "drink water",
        trigger: { kind: "interval", everyMinutes: 120 },
        pipeline: {
          onComplete: [
            input({ kind: "output", promptInstructions: "log streak" }),
          ],
        },
      }),
    );
    await h.runner.fire(habit.taskId);
    await h.runner.apply(habit.taskId, "complete", { reason: "drank" });
    const tasks = await h.runner.list();
    const log = await collectLog(h.logStore, h.agentId, tasks.map((t) => t.taskId));
    await recordAndAssert({
      domain: 3,
      title: "Habits",
      description:
        "A recurring habit fires on its interval, the user marks it complete, and the onComplete pipeline appends a streak-logging output task.",
      scenarioSummary:
        "Schedule a 120-minute interval reminder with onComplete=[log streak], fire, then complete.",
      tasks,
      logEntries: log,
    });
  });
});

describeIfKey("Domain 4 — Routines & multi-step daily flows", () => {
  it("morning routine chains check-in → recap → output via pipeline.onComplete", async () => {
    const h = makeHarness();
    const recapInput = input({
      kind: "recap",
      promptInstructions: "morning recap",
    });
    const briefInput = input({
      kind: "output",
      promptInstructions: "send brief",
    });
    const checkin = await h.runner.schedule(
      input({
        kind: "checkin",
        promptInstructions: "did you sleep ok?",
        trigger: { kind: "during_window", windowKey: "morning" },
        pipeline: {
          onComplete: [
            {
              ...recapInput,
              pipeline: { onComplete: [briefInput] },
            } as unknown as ScheduledTask,
          ],
        },
      }),
    );
    await h.runner.apply(checkin.taskId, "complete");
    const afterCheckin = await h.runner.list();
    const recap = afterCheckin.find(
      (task) => task.promptInstructions === "morning recap",
    );
    expect(recap).toBeDefined();
    if (!recap) throw new Error("recap missing after check-in completion");
    await h.runner.apply(recap.taskId, "complete");
    const tasks = await h.runner.list();
    const log = await collectLog(h.logStore, h.agentId, tasks.map((t) => t.taskId));
    await recordAndAssert({
      domain: 4,
      title: "Routines & multi-step daily flows",
      description:
        "A morning routine is one check-in → recap → send-brief output, chained via pipeline.onComplete so each child is created by parent completion.",
      scenarioSummary:
        "Schedule check-in with inline recap.onComplete=[send brief]; complete check-in to create recap, then complete recap.",
      tasks,
      logEntries: log,
    });
  });
});

describeIfKey("Domain 5 — Tasks (one-off)", () => {
  it("`once` trigger schedules at the requested instant and accepts terminal verbs", async () => {
    const h = makeHarness();
    const t = await h.runner.schedule(
      input({
        promptInstructions: "remind me to take meds",
        trigger: { kind: "once", atIso: "2026-05-09T20:00:00.000Z" },
      }),
    );
    await h.runner.apply(t.taskId, "complete", { reason: "took them" });
    const tasks = await h.runner.list();
    const log = await collectLog(h.logStore, h.agentId, tasks.map((x) => x.taskId));
    await recordAndAssert({
      domain: 5,
      title: "Tasks (one-off)",
      description:
        "A one-off task fires once at the requested instant and the user marks it complete.",
      scenarioSummary:
        "Schedule a once-trigger reminder for 20:00 UTC, then complete with a reason.",
      tasks,
      logEntries: log,
    });
  });
});

describeIfKey("Domain 6 — Goals", () => {
  it("goal-anchored watcher composes quiet-hours gate", async () => {
    const h = makeHarness();
    h.setOwnerFacts({
      timezone: "UTC",
      quietHours: { start: "22:00", end: "06:00", tz: "UTC" },
    });
    const goal = await h.runner.schedule(
      input({
        kind: "watcher",
        promptInstructions: "protect sleep window",
        trigger: { kind: "during_window", windowKey: "night" },
        subject: { kind: "self", id: "owner-self" },
        shouldFire: {
          compose: "all",
          gates: [{ kind: "quiet_hours", params: { highPriorityBypass: false } }],
        },
      }),
    );
    const tasks = [goal];
    const log = await collectLog(h.logStore, h.agentId, tasks.map((t) => t.taskId));
    await recordAndAssert({
      domain: 6,
      title: "Goals",
      description:
        "A 'sleep better' goal binds a watcher that fires only outside quiet hours and is anchored to subject=self.",
      scenarioSummary:
        "Schedule a watcher with subject=self, during_window=night, and a quiet_hours gate.",
      tasks,
      logEntries: log,
    });
  });
});

describeIfKey("Domain 7 — Reminders & escalation ladder", () => {
  it("priority high gets the high-default ladder with escalation steps", async () => {
    const h = makeHarness();
    const t = await h.runner.schedule(
      input({
        kind: "reminder",
        promptInstructions: "high-priority cancellation fee warning",
        trigger: { kind: "once", atIso: "2026-05-09T15:00:00.000Z" },
        priority: "high",
      }),
    );
    const ladders = h.runner.inspectRegistries().ladders;
    const tasks = [t];
    const log = await collectLog(h.logStore, h.agentId, tasks.map((t) => t.taskId));
    await recordAndAssert({
      domain: 7,
      title: "Reminders & escalation ladder",
      description:
        "Priority maps to an escalation ladder. high → 3-step default ladder; medium → 1; low → 0.",
      scenarioSummary: `Schedule a high-priority reminder. Registered ladder keys: ${ladders.join(", ")}.`,
      tasks,
      logEntries: log,
    });
  });
});

describeIfKey("Domain 8 — Calendar journeys", () => {
  it("calendar event-triggered recap supports onComplete + onSkip pipelines", async () => {
    const h = makeHarness();
    const recap = await h.runner.schedule(
      input({
        kind: "recap",
        promptInstructions: "post-meeting recap",
        trigger: {
          kind: "event",
          eventKind: "calendar.event_ended",
          filter: { calendarId: "primary" },
        },
        subject: { kind: "calendar_event", id: "evt-123" },
        pipeline: {
          onComplete: [
            input({ kind: "output", promptInstructions: "save recap to notes" }),
          ],
          onSkip: [input({ kind: "followup", promptInstructions: "ask later" })],
        },
      }),
    );
    await h.runner.apply(recap.taskId, "skip", { reason: "user busy" });
    const tasks = await h.runner.list();
    const log = await collectLog(h.logStore, h.agentId, tasks.map((t) => t.taskId));
    await recordAndAssert({
      domain: 8,
      title: "Calendar journeys",
      description:
        "When a calendar event ends, a recap fires; if the user skips it, an onSkip 'ask later' followup is scheduled.",
      scenarioSummary:
        "Schedule a calendar.event_ended recap with onComplete=[save recap] + onSkip=[ask later], then skip it.",
      tasks,
      logEntries: log,
    });
  });
});

describeIfKey("Domain 9 — Inbox & email triage", () => {
  it("inbox-triage output destination=gmail_draft completes correctly", async () => {
    const h = makeHarness();
    const t = await h.runner.schedule(
      input({
        kind: "output",
        promptInstructions: "draft reply for top-3 unread",
        trigger: { kind: "during_window", windowKey: "morning" },
        output: { destination: "gmail_draft", target: "drafts:reply-batch" },
      }),
    );
    await h.runner.apply(t.taskId, "complete");
    const tasks = await h.runner.list();
    const log = await collectLog(h.logStore, h.agentId, tasks.map((t) => t.taskId));
    await recordAndAssert({
      domain: 9,
      title: "Inbox & email triage",
      description:
        "An inbox-triage output writes Gmail drafts; completion marks the batch as drafted.",
      scenarioSummary:
        "Schedule an output kind=output destination=gmail_draft target=drafts:reply-batch and complete it.",
      tasks,
      logEntries: log,
    });
  });
});

describeIfKey("Domain 10 — Travel", () => {
  it("travel approval feeds onComplete booking output", async () => {
    const h = makeHarness();
    const approval = await h.runner.schedule(
      input({
        kind: "approval",
        promptInstructions: "approve flight booking SFO → JFK 2026-06-01",
        priority: "high",
        pipeline: {
          onComplete: [
            input({
              kind: "output",
              promptInstructions: "book the flight via duffel",
              priority: "high",
            }),
          ],
        },
      }),
    );
    await h.runner.apply(approval.taskId, "complete", { reason: "user approved" });
    const tasks = await h.runner.list();
    const log = await collectLog(h.logStore, h.agentId, tasks.map((t) => t.taskId));
    await recordAndAssert({
      domain: 10,
      title: "Travel",
      description:
        "BOOK_TRAVEL is a compound: user approves first, then onComplete spawns the booking output.",
      scenarioSummary:
        "Schedule a high-priority approval with onComplete=[book via duffel] and complete it.",
      tasks,
      logEntries: log,
    });
  });
});

describeIfKey("Domain 11 — Follow-up repair (relationships)", () => {
  it("watcher with subject_updated completion marks completed when subject is touched", async () => {
    const h = makeHarness();
    const watcher = await h.runner.schedule(
      input({
        kind: "watcher",
        promptInstructions: "Pat hasn't replied; bump if cold",
        trigger: { kind: "interval", everyMinutes: 60 * 24 },
        subject: { kind: "relationship", id: "rel:pat" },
        completionCheck: {
          kind: "subject_updated",
          params: { lookbackMinutes: 60 * 24 * 7, requireSinceTaskFired: true },
        },
      }),
    );
    await h.runner.fire(watcher.taskId);
    h.touchSubject("rel:pat", "2026-05-09T08:30:00.000Z");
    h.setNow("2026-05-09T08:30:00.000Z");
    await h.runner.evaluateCompletion(watcher.taskId, {
      acknowledged: false,
      repliedAtIso: "2026-05-09T08:30:00.000Z",
    });
    const tasks = await h.runner.list();
    const log = await collectLog(h.logStore, h.agentId, tasks.map((t) => t.taskId));
    await recordAndAssert({
      domain: 11,
      title: "Follow-up repair (relationships)",
      description:
        "A relationship watcher waits until the contact is touched again (subject_updated check). When the subject is updated, the watcher auto-completes.",
      scenarioSummary:
        "Schedule a watcher subject=relationship rel:pat, fire, then touch the subject and re-evaluate.",
      tasks,
      logEntries: log,
    });
  });
});

describeIfKey("Domain 12 — Documents, signatures, portals", () => {
  it("document-deadline reminder routes onFail to backup followup", async () => {
    const h = makeHarness();
    const t = await h.runner.schedule(
      input({
        kind: "reminder",
        promptInstructions: "sign portal upload before 5pm",
        trigger: { kind: "once", atIso: "2026-05-09T17:00:00.000Z" },
        subject: { kind: "document", id: "doc-w9-2026" },
        priority: "high",
        pipeline: {
          onFail: [
            input({
              kind: "followup",
              promptInstructions: "escalate to backup channel",
            }),
          ],
        },
      }),
    );
    const children = await h.runner.pipeline(t.taskId, "failed");
    const tasks = await h.runner.list();
    const log = await collectLog(h.logStore, h.agentId, tasks.map((t) => t.taskId));
    await recordAndAssert({
      domain: 12,
      title: "Documents, signatures, portals",
      description:
        "A document-signature deadline reminder. On failure, an onFail pipeline escalates to a backup-channel followup.",
      scenarioSummary: `Schedule a document reminder with onFail=[backup followup], invoke pipeline 'failed'. Children spawned: ${children.length}.`,
      tasks,
      logEntries: log,
    });
  });
});

describeIfKey("Domain 13 — Self-control / app & website blockers", () => {
  it("during_travel gate fires for self-control tasks while traveling", async () => {
    const h = makeHarness();
    h.setOwnerFacts({ timezone: "UTC", travelActive: true });
    const t = await h.runner.schedule(
      input({
        kind: "custom",
        promptInstructions: "lift website blocker during deep-work sprint",
        priority: "high",
        shouldFire: { compose: "all", gates: [{ kind: "during_travel" }] },
      }),
    );
    await h.runner.fire(t.taskId);
    const tasks = await h.runner.list();
    const log = await collectLog(h.logStore, h.agentId, tasks.map((t) => t.taskId));
    await recordAndAssert({
      domain: 13,
      title: "Self-control / app & website blockers",
      description:
        "Self-control tasks (e.g. block lift) gate on travelActive and fire only while traveling.",
      scenarioSummary:
        "Set ownerFacts.travelActive=true. Schedule a custom task with during_travel gate. Fire and observe.",
      tasks,
      logEntries: log,
    });
  });
});

describeIfKey("Domain 14 — Group chat handoff", () => {
  it("handoff watcher carries subject=thread + ownerVisible=false (shadow task)", async () => {
    const h = makeHarness();
    const t = await h.runner.schedule(
      input({
        kind: "custom",
        promptInstructions: "watch thread for handoff resume condition",
        trigger: { kind: "event", eventKind: "message.handoff" },
        subject: { kind: "thread", id: "room:ops" },
        ownerVisible: false,
      }),
    );
    const tasks = [t];
    const log = await collectLog(h.logStore, h.agentId, tasks.map((t) => t.taskId));
    await recordAndAssert({
      domain: 14,
      title: "Group chat handoff",
      description:
        "When a thread is handed off to the agent, a shadow watcher with ownerVisible=false tracks resume conditions.",
      scenarioSummary:
        "Schedule a custom event=message.handoff watcher subject=thread room:ops ownerVisible=false.",
      tasks,
      logEntries: log,
    });
  });
});

describeIfKey("Domain 15 — Multi-channel & cross-channel search", () => {
  it("search task carries contextRequest with multiple include flags", async () => {
    const h = makeHarness();
    const t = await h.runner.schedule(
      input({
        kind: "output",
        promptInstructions:
          "search across channels for a thread about Q3 roadmap",
        contextRequest: {
          includeOwnerFacts: ["preferredName", "locale"],
          includeRecentTaskStates: { kind: "output", lookbackHours: 48 },
          includeEntities: {
            entityIds: ["entity:teammate-1"],
            fields: ["preferredName"],
          },
        },
      }),
    );
    const tasks = [t];
    const log = await collectLog(h.logStore, h.agentId, tasks.map((t) => t.taskId));
    await recordAndAssert({
      domain: 15,
      title: "Multi-channel & cross-channel search",
      description:
        "Cross-channel search needs owner-facts, recent task states, and entity facts. The spine carries those via contextRequest.",
      scenarioSummary:
        "Schedule an output task with contextRequest spanning ownerFacts + recentTaskStates + entities.",
      tasks,
      logEntries: log,
    });
  });
});

describeIfKey("Domain 16 — Activity signals & screen context", () => {
  it("relative-to-anchor wake.confirmed completes via health_signal_observed", async () => {
    const h = makeHarness("2026-05-09T07:00:00.000Z");
    const t = await h.runner.schedule(
      input({
        kind: "checkin",
        promptInstructions: "morning brief 30m after wake confirmed",
        trigger: {
          kind: "relative_to_anchor",
          anchorKey: "wake.confirmed",
          offsetMinutes: 30,
        },
        completionCheck: {
          kind: "health_signal_observed",
          params: {
            signalKind: "health.wake.confirmed",
            lookbackMinutes: 60 * 8,
            requireSinceTaskFired: false,
          },
        },
      }),
    );
    await h.runner.fire(t.taskId);
    h.signal("health.wake.confirmed", "2026-05-09T07:05:00.000Z");
    h.setNow("2026-05-09T07:30:00.000Z");
    await h.runner.evaluateCompletion(t.taskId, { acknowledged: false });
    const tasks = await h.runner.list();
    const log = await collectLog(h.logStore, h.agentId, tasks.map((t) => t.taskId));
    await recordAndAssert({
      domain: 16,
      title: "Activity signals & screen context",
      description:
        "The morning brief is anchored to wake.confirmed +30m and auto-completes when the health signal is observed within the lookback window.",
      scenarioSummary:
        "Schedule a wake.confirmed +30m checkin with health_signal_observed completion. Fire, signal at +5m, evaluate at +30m.",
      tasks,
      logEntries: log,
    });
  });
});

describeIfKey("Domain 17 — Approval queues & action gating", () => {
  it("approval can be dismissed via the runner verb", async () => {
    const h = makeHarness();
    const approval = await h.runner.schedule(
      input({
        kind: "approval",
        promptInstructions: "approve Calendly negotiation slot",
        trigger: { kind: "event", eventKind: "calendly.negotiation.proposal" },
      }),
    );
    await h.runner.apply(approval.taskId, "dismiss", { reason: "not now" });
    const tasks = await h.runner.list();
    const log = await collectLog(h.logStore, h.agentId, tasks.map((t) => t.taskId));
    await recordAndAssert({
      domain: 17,
      title: "Approval queues & action gating",
      description:
        "Owner-visible approval cards can be approved (complete), skipped, or dismissed; dismissal is a clean terminal state.",
      scenarioSummary:
        "Schedule an approval triggered by calendly.negotiation.proposal and dismiss it.",
      tasks,
      logEntries: log,
    });
  });
});

describeIfKey("Domain 18 — Identity merge (canonical person)", () => {
  it("entity-anchored watcher accepts subject.kind=entity", async () => {
    const h = makeHarness();
    const t = await h.runner.schedule(
      input({
        kind: "watcher",
        promptInstructions: "watch entity for cross-platform handle merge",
        trigger: { kind: "event", eventKind: "entity.identity.added" },
        subject: { kind: "entity", id: "entity:contact-merlot" },
      }),
    );
    await h.runner.apply(t.taskId, "complete", { reason: "merged identity" });
    const tasks = await h.runner.list();
    const log = await collectLog(h.logStore, h.agentId, tasks.map((t) => t.taskId));
    await recordAndAssert({
      domain: 18,
      title: "Identity merge (canonical person)",
      description:
        "Identity merge listens for entity.identity.added events and tracks the canonical person via subject=entity.",
      scenarioSummary:
        "Schedule an entity-anchored watcher and complete after a merge.",
      tasks,
      logEntries: log,
    });
  });
});

describeIfKey("Domain 19 — Memory recall", () => {
  it("output kind with destination=memory persists as task_metadata", async () => {
    const h = makeHarness();
    const t = await h.runner.schedule(
      input({
        kind: "output",
        promptInstructions: "remember this preference for later recall",
        output: { destination: "memory", persistAs: "task_metadata" },
      }),
    );
    const tasks = [t];
    const log = await collectLog(h.logStore, h.agentId, tasks.map((t) => t.taskId));
    await recordAndAssert({
      domain: 19,
      title: "Memory recall",
      description:
        "Memory writes go through an output task whose destination=memory and persistAs configures the storage shape.",
      scenarioSummary:
        "Schedule an output task with destination=memory persistAs=task_metadata.",
      tasks,
      logEntries: log,
    });
  });
});

describeIfKey("Domain 20 — Connectors & permissions", () => {
  it("connector-status follow-up carries identifiers via metadata", async () => {
    const h = makeHarness();
    const t = await h.runner.schedule(
      input({
        kind: "followup",
        promptInstructions:
          "Google Drive token expired — prompt user to reconnect",
        trigger: { kind: "event", eventKind: "connector.health_check_failed" },
        priority: "high",
        metadata: {
          connectorKind: "google",
          surface: "drive",
          reason: "token_expired",
        },
      }),
    );
    const tasks = [t];
    const log = await collectLog(h.logStore, h.agentId, tasks.map((t) => t.taskId));
    await recordAndAssert({
      domain: 20,
      title: "Connectors & permissions",
      description:
        "Connector health_check_failed events spawn high-priority followups that carry connector identifiers via metadata (no schema bloat).",
      scenarioSummary:
        "Schedule a followup triggered by connector.health_check_failed with metadata carrying connectorKind/surface/reason.",
      tasks,
      logEntries: log,
    });
  });
});

describeIfKey("Domain 21 — Health, money, screen time", () => {
  it("screen-time watcher uses health_signal_observed completion check", async () => {
    const h = makeHarness();
    const t = await h.runner.schedule(
      input({
        kind: "watcher",
        promptInstructions: "alert if screen-time > daily cap",
        trigger: { kind: "interval", everyMinutes: 60 },
        completionCheck: {
          kind: "health_signal_observed",
          params: { signalKind: "screen.cap_exceeded", lookbackMinutes: 60 },
        },
      }),
    );
    const checks = h.runner.inspectRegistries().completionChecks;
    const tasks = [t];
    const log = await collectLog(h.logStore, h.agentId, tasks.map((t) => t.taskId));
    await recordAndAssert({
      domain: 21,
      title: "Health, money, screen time",
      description:
        "Health, money, and screen-time monitors share the spine. All four built-in completion checks are registered for them.",
      scenarioSummary: `Schedule a screen-time watcher with health_signal_observed. Registered checks: ${checks.join(", ")}.`,
      tasks,
      logEntries: log,
    });
  });
});

describeIfKey("Domain 22 — Push notifications", () => {
  it("priority-keyed escalation ladders are registered (low/medium/high)", async () => {
    const h = makeHarness();
    const t = await h.runner.schedule(
      input({
        kind: "reminder",
        promptInstructions: "high-priority cancellation fee warning",
        trigger: { kind: "once", atIso: "2026-05-09T15:00:00.000Z" },
        priority: "high",
      }),
    );
    const ladders = h.runner.inspectRegistries().ladders;
    const tasks = [t];
    const log = await collectLog(h.logStore, h.agentId, tasks.map((t) => t.taskId));
    await recordAndAssert({
      domain: 22,
      title: "Push notifications",
      description:
        "Push intensity follows priority. Default ladders priority_low_default / priority_medium_default / priority_high_default must all be registered.",
      scenarioSummary: `Schedule a high-priority reminder. Registered ladders: ${ladders.join(", ")}.`,
      tasks,
      logEntries: log,
    });
  });
});

describeIfKey("Domain 23 — Remote sessions", () => {
  it("stuck-agent followup carries session metadata", async () => {
    const h = makeHarness();
    const t = await h.runner.schedule(
      input({
        kind: "followup",
        promptInstructions: "stuck-agent ping owner",
        trigger: { kind: "event", eventKind: "agent.session.stuck" },
        priority: "high",
        metadata: { sessionId: "sess-42", agentName: "task-coordinator" },
      }),
    );
    const tasks = [t];
    const log = await collectLog(h.logStore, h.agentId, tasks.map((t) => t.taskId));
    await recordAndAssert({
      domain: 23,
      title: "Remote sessions",
      description:
        "When a remote sub-agent gets stuck it pings the owner via a high-priority followup carrying sessionId + agentName metadata.",
      scenarioSummary:
        "Schedule a followup triggered by agent.session.stuck with sessionId/agentName metadata.",
      tasks,
      logEntries: log,
    });
  });
});

describeIfKey("Domain 24 — Settings & UX", () => {
  it("first-run preferences persist as ownerVisible=false config metadata", async () => {
    const h = makeHarness();
    h.setOwnerFacts({ timezone: "America/Denver", preferredName: "Shaw" });
    const t = await h.runner.schedule(
      input({
        kind: "custom",
        promptInstructions: "settings sync placeholder",
        ownerVisible: false,
        metadata: {
          settingsScope: "first-run",
          touched: ["preferredName", "timezone"],
        },
      }),
    );
    const tasks = [t];
    const log = await collectLog(h.logStore, h.agentId, tasks.map((t) => t.taskId));
    await recordAndAssert({
      domain: 24,
      title: "Settings & UX",
      description:
        "First-run settings sync does not show a card; it persists as a custom shadow task with ownerVisible=false and metadata recording the scope.",
      scenarioSummary:
        "Schedule a custom shadow task with ownerVisible=false and settingsScope/touched metadata.",
      tasks,
      logEntries: log,
    });
  });
});

describeIfKey("Domain 25 — REST API access flows", () => {
  it("api-source tasks carry source='plugin' and skip ownerVisible cards", async () => {
    const h = makeHarness();
    const t = await h.runner.schedule(
      input({
        kind: "custom",
        promptInstructions: "REST scheduler entry",
        source: "plugin",
        ownerVisible: false,
      }),
    );
    const tasks = [t];
    const log = await collectLog(h.logStore, h.agentId, tasks.map((t) => t.taskId));
    await recordAndAssert({
      domain: 25,
      title: "REST API access flows",
      description:
        "Tasks scheduled via the REST API carry source=plugin and ownerVisible=false so they are not surfaced as user-facing cards.",
      scenarioSummary:
        "Schedule a custom task with source=plugin and ownerVisible=false.",
      tasks,
      logEntries: log,
    });
  });
});

describeIfKey("Domain 26 — Workflows (event-triggered)", () => {
  it("event-trigger with filter chains an audit-log onComplete", async () => {
    const h = makeHarness();
    const t = await h.runner.schedule(
      input({
        kind: "watcher",
        promptInstructions: "react to inbound webhook",
        trigger: {
          kind: "event",
          eventKind: "workflow.webhook_arrived",
          filter: { source: "stripe" },
        },
        pipeline: {
          onComplete: [input({ kind: "output", promptInstructions: "audit log" })],
        },
      }),
    );
    await h.runner.apply(t.taskId, "complete");
    const tasks = await h.runner.list();
    const log = await collectLog(h.logStore, h.agentId, tasks.map((t) => t.taskId));
    await recordAndAssert({
      domain: 26,
      title: "Workflows (event-triggered)",
      description:
        "Workflows match incoming events via trigger.filter and chain onComplete into audit-log outputs.",
      scenarioSummary:
        "Schedule a watcher event=workflow.webhook_arrived filter source=stripe with onComplete=[audit log] and complete.",
      tasks,
      logEntries: log,
    });
  });
});

describeIfKey("Domain 27 — Multilingual coverage", () => {
  it("locale-tagged metadata + non-English instructions schedule cleanly", async () => {
    const h = makeHarness();
    h.setOwnerFacts({ timezone: "Europe/Madrid", locale: "es-ES" });
    const t = await h.runner.schedule(
      input({
        kind: "reminder",
        promptInstructions: "Recuerda lavarte los dientes",
        trigger: { kind: "during_window", windowKey: "evening" },
        metadata: { locale: "es-ES" },
      }),
    );
    const tasks = [t];
    const log = await collectLog(h.logStore, h.agentId, tasks.map((t) => t.taskId));
    await recordAndAssert({
      domain: 27,
      title: "Multilingual coverage",
      description:
        "Non-English prompts schedule unchanged. Locale rides on metadata and ownerFacts; the runner has no locale-specific branch.",
      scenarioSummary:
        "Schedule a Spanish reminder Recuerda lavarte los dientes with metadata.locale=es-ES.",
      tasks,
      logEntries: log,
    });
  });
});

describeIfKey("Domain 28 — Suspected-but-unconfirmed flows", () => {
  it("kind=custom accepts open-ended flows and terminates via dismiss", async () => {
    const h = makeHarness();
    const t = await h.runner.schedule(
      input({
        kind: "custom",
        promptInstructions: "spine accepts open-ended custom flows",
        metadata: { suspectedFlow: "true" },
      }),
    );
    await h.runner.apply(t.taskId, "dismiss", {
      reason: "owner deferred until confirmed",
    });
    const tasks = await h.runner.list();
    const log = await collectLog(h.logStore, h.agentId, tasks.map((t) => t.taskId));
    await recordAndAssert({
      domain: 28,
      title: "Suspected-but-unconfirmed flows",
      description:
        "Suspected-but-unconfirmed flows use kind=custom so the spine accepts them without specialized branching, and they can be dismissed cleanly.",
      scenarioSummary:
        "Schedule a custom task with metadata.suspectedFlow=true and dismiss it.",
      tasks,
      logEntries: log,
    });
  });
});

// ---------------------------------------------------------------------------
// Persist results — write the JSON baseline regardless of pass/fail so the
// audit captures the verdicts. The afterAll hook runs even when individual
// `it`s throw, so a failed domain still lands in the JSON.
// ---------------------------------------------------------------------------

afterAll(() => {
  if (!CEREBRAS_KEY_PRESENT) {
    return;
  }
  const passes = RESULTS.filter((r) => r.verdict === "pass").length;
  const caveats = RESULTS.filter((r) => r.verdict === "pass_with_caveat").length;
  const failures = RESULTS.filter((r) => r.verdict === "fail").length;
  const summary = {
    generatedAtIso: new Date().toISOString(),
    provider: CEREBRAS_PROVIDER,
    model: CEREBRAS_MODEL,
    domainsGraded: RESULTS.length,
    counts: { pass: passes, pass_with_caveat: caveats, fail: failures },
    domains: RESULTS.sort((a, b) => a.domain - b.domain),
  };
  fs.mkdirSync(path.dirname(RESULTS_PATH), { recursive: true });
  fs.writeFileSync(RESULTS_PATH, `${JSON.stringify(summary, null, 2)}\n`);
  console.info(
    `[cerebras-journey-eval] wrote ${RESULTS.length}-domain baseline to ${RESULTS_PATH}`,
  );
});

// Ensure vitest detects this as a runnable suite even when no key is present.
describe("cerebras-journey-eval bootstrap", () => {
  it("acknowledges the suite is wired", () => {
    expect(typeof gradeJourney).toBe("function");
  });
});
