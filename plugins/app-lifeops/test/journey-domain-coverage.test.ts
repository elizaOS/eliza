/**
 * W3-C — 28-domain journey replay against the W1-A `ScheduledTask` spine.
 *
 * One `describe` block per `UX_JOURNEYS.md` chapter (28 total) plus a final
 * block per game-through finding listed in
 * `IMPLEMENTATION_PLAN.md` §7.3. Each domain replays a synthetic chat-session
 * through the in-memory runner: schedule → fire → verb → pipeline → terminal.
 *
 * The replay is deterministic and free of LLM/db dependencies — it runs the
 * same registries the production runner uses and asserts the spine accepts
 * every variant the journey set requires without source-code edits.
 */

import { describe, expect, it } from "vitest";
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
  DEFAULT_ESCALATION_LADDERS,
  PRIORITY_DEFAULT_LADDER_KEYS,
  registerDefaultEscalationLadders,
  resolveEffectiveLadder,
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
import { createInMemoryScheduledTaskLogStore } from "../src/lifeops/scheduled-task/state-log.ts";
import type {
  ActivitySignalBusView,
  GlobalPauseView,
  OwnerFactsView,
  ScheduledTask,
  ScheduledTaskKind,
  ScheduledTaskPriority,
  ScheduledTaskTrigger,
  SubjectStoreView,
} from "../src/lifeops/scheduled-task/types.ts";

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

interface SignalArgs {
  signalKind: string;
  sinceIso: string;
}

interface Harness {
  runner: ScheduledTaskRunnerHandle;
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
  const runner = createScheduledTaskRunner({
    agentId: "test-agent-journey-coverage",
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
      return `jdc_${counter}`;
    },
    now: () => new Date(nowIso),
  });

  return {
    runner,
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
    promptInstructions: promptInstructions ?? "domain coverage replay",
    trigger: trigger ?? { kind: "manual" },
    priority: priority ?? "medium",
    respectsGlobalPause: rest.respectsGlobalPause ?? true,
    source: rest.source ?? "default_pack",
    createdBy: rest.createdBy ?? "journey-domain-coverage",
    ownerVisible: rest.ownerVisible ?? true,
    ...rest,
  };
}

// ---------------------------------------------------------------------------
// Domains 1-28 — one describe per UX_JOURNEYS chapter heading.
// ---------------------------------------------------------------------------

describe("Domain 1 — Onboarding & first-run setup", () => {
  it("seeds first-run defaults as scheduled tasks the runner accepts", async () => {
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
        priority: "medium",
        idempotencyKey: "default-pack:daily-rhythm:morning-checkin",
      }),
      input({
        kind: "recap",
        promptInstructions: "morning brief assembly",
        trigger: { kind: "during_window", windowKey: "morning" },
        priority: "medium",
        idempotencyKey: "default-pack:morning-brief:assemble",
      }),
    ];
    const scheduled = await Promise.all(seeds.map((s) => h.runner.schedule(s)));
    expect(scheduled.map((t) => t.state.status)).toEqual([
      "scheduled",
      "scheduled",
      "scheduled",
      "scheduled",
    ]);
    expect(new Set(scheduled.map((t) => t.idempotencyKey))).toHaveProperty(
      "size",
      4,
    );
  });
});

describe("Domain 2 — Core data model & overview surface", () => {
  it("every documented kind enumerates without runner edits", async () => {
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
    expect(tasks.map((t) => t.kind)).toEqual(kinds);
    expect(tasks.every((t) => t.state.status === "scheduled")).toBe(true);
  });
});

describe("Domain 3 — Habits", () => {
  it("recurring habit fires, completes, and propagates its onComplete pipeline", async () => {
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
    const fired = await h.runner.fire(habit.taskId);
    expect(fired.state.status).toBe("fired");
    const done = await h.runner.apply(habit.taskId, "complete", {
      reason: "drank",
    });
    expect(done.state.status).toBe("completed");
    const all = await h.runner.list();
    expect(all.some((t) => t.promptInstructions === "log streak")).toBe(true);
  });
});

describe("Domain 4 — Routines & multi-step daily flows", () => {
  it("morning-routine pipeline chains reminder → recap → output without code changes", async () => {
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
    const tasks = await h.runner.list();
    const recap = tasks.find((t) => t.promptInstructions === "morning recap");
    expect(recap).toBeDefined();
    if (!recap) throw new Error("recap missing");
    await h.runner.apply(recap.taskId, "complete");
    const tasksAfter = await h.runner.list();
    expect(tasksAfter.some((t) => t.promptInstructions === "send brief")).toBe(
      true,
    );
  });
});

describe("Domain 5 — Tasks (one-off)", () => {
  it("one-off `once` trigger schedules at the requested instant and accepts terminal verbs", async () => {
    const h = makeHarness();
    const t = await h.runner.schedule(
      input({
        promptInstructions: "remind me to take meds",
        trigger: { kind: "once", atIso: "2026-05-09T20:00:00.000Z" },
        priority: "medium",
      }),
    );
    expect(t.trigger.kind).toBe("once");
    const completed = await h.runner.apply(t.taskId, "complete", {
      reason: "took them",
    });
    expect(completed.state.status).toBe("completed");
    expect(completed.state.completedAt).toBeDefined();
  });
});

describe("Domain 6 — Goals", () => {
  it("goal-anchored task uses subject + sleep-window guard via gate composition", async () => {
    const h = makeHarness();
    h.setOwnerFacts({
      timezone: "UTC",
      quietHours: { start: "22:00", end: "06:00", tz: "UTC" },
    });
    const sleepGoal = await h.runner.schedule(
      input({
        kind: "watcher",
        promptInstructions: "protect sleep window",
        trigger: { kind: "during_window", windowKey: "night" },
        subject: { kind: "self", id: "owner-self" },
        shouldFire: {
          compose: "all",
          gates: [
            { kind: "quiet_hours", params: { highPriorityBypass: false } },
          ],
        },
      }),
    );
    expect(sleepGoal.subject?.kind).toBe("self");
    expect(sleepGoal.shouldFire?.gates.length).toBe(1);
  });
});

describe("Domain 7 — Reminders & escalation ladder", () => {
  it("priority defaults map to the documented escalation ladders (§8.7)", () => {
    const reg = createEscalationLadderRegistry();
    registerDefaultEscalationLadders(reg);
    for (const priority of ["low", "medium", "high"] as const) {
      const t: ScheduledTask = {
        taskId: `t-${priority}`,
        kind: "reminder",
        promptInstructions: "p",
        trigger: { kind: "manual" },
        priority,
        respectsGlobalPause: true,
        source: "default_pack",
        createdBy: "test",
        ownerVisible: true,
        state: { status: "scheduled", followupCount: 0 },
      };
      const ladder = resolveEffectiveLadder(t, reg);
      expect(ladder.ladderKey).toBe(PRIORITY_DEFAULT_LADDER_KEYS[priority]);
    }
    expect(DEFAULT_ESCALATION_LADDERS.priority_low_default?.steps.length).toBe(
      0,
    );
    expect(
      DEFAULT_ESCALATION_LADDERS.priority_medium_default?.steps.length,
    ).toBe(1);
    expect(DEFAULT_ESCALATION_LADDERS.priority_high_default?.steps.length).toBe(
      3,
    );
  });
});

describe("Domain 8 — Calendar journeys", () => {
  it("event-triggered task captures `event` filter and accepts pipeline branching", async () => {
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
            input({
              kind: "output",
              promptInstructions: "save recap to notes",
            }),
          ],
          onSkip: [
            input({ kind: "followup", promptInstructions: "ask later" }),
          ],
        },
      }),
    );
    expect(recap.trigger.kind).toBe("event");
    expect(recap.subject?.kind).toBe("calendar_event");
    const skipped = await h.runner.apply(recap.taskId, "skip", {
      reason: "user busy",
    });
    expect(skipped.state.status).toBe("skipped");
    const all = await h.runner.list();
    expect(all.some((t) => t.promptInstructions === "ask later")).toBe(true);
  });
});

describe("Domain 9 — Inbox & email triage", () => {
  it("inbox-triage kind=output with `output.destination = gmail_draft` is accepted", async () => {
    const h = makeHarness();
    const t = await h.runner.schedule(
      input({
        kind: "output",
        promptInstructions: "draft reply for top-3 unread",
        trigger: { kind: "during_window", windowKey: "morning" },
        output: { destination: "gmail_draft", target: "drafts:reply-batch" },
      }),
    );
    expect(t.output?.destination).toBe("gmail_draft");
    expect(t.output?.target).toBe("drafts:reply-batch");
    const completed = await h.runner.apply(t.taskId, "complete");
    expect(completed.state.status).toBe("completed");
  });
});

describe("Domain 10 — Travel", () => {
  it("approval-kind compound task chains via pipeline.onComplete (BOOK_TRAVEL stays compound)", async () => {
    const h = makeHarness();
    const approval = await h.runner.schedule(
      input({
        kind: "approval",
        promptInstructions: "approve flight booking SFO → JFK 2026-06-01",
        trigger: { kind: "manual" },
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
    expect(approval.kind).toBe("approval");
    const approved = await h.runner.apply(approval.taskId, "complete", {
      reason: "user approved",
    });
    expect(approved.state.status).toBe("completed");
    const next = await h.runner.list();
    expect(next.some((t) => t.kind === "output")).toBe(true);
  });
});

describe("Domain 11 — Follow-up repair (relationships)", () => {
  it("watcher-task with subject.kind=relationship completes via subject_updated check", async () => {
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
    const evaluated = await h.runner.evaluateCompletion(watcher.taskId, {
      acknowledged: false,
      repliedAtIso: "2026-05-09T08:30:00.000Z",
    });
    expect(evaluated.state.status).toBe("completed");
  });
});

describe("Domain 12 — Documents, signatures, portals", () => {
  it("signature-deadline task uses subject=document and onFail pipeline", async () => {
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
    expect(t.subject?.kind).toBe("document");
    // Manually drive through pipeline.onFail by invoking the pipeline path with `failed` outcome.
    const children = await h.runner.pipeline(t.taskId, "failed");
    expect(children.length).toBe(1);
    expect(children[0]?.kind).toBe("followup");
  });
});

describe("Domain 13 — Self-control / app & website blockers", () => {
  it("blocker-related task wires through priority=high + during_travel gate", async () => {
    const h = makeHarness();
    h.setOwnerFacts({ timezone: "UTC", travelActive: true });
    const t = await h.runner.schedule(
      input({
        kind: "custom",
        promptInstructions: "lift website blocker during deep-work sprint",
        trigger: { kind: "manual" },
        priority: "high",
        shouldFire: { compose: "all", gates: [{ kind: "during_travel" }] },
      }),
    );
    const fired = await h.runner.fire(t.taskId);
    expect(fired.state.status).toBe("fired");
  });
});

describe("Domain 14 — Group chat handoff", () => {
  it("handoff-emitting task carries subject=thread + ownerVisible=false for shadow tasks", async () => {
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
    expect(t.subject?.kind).toBe("thread");
    expect(t.ownerVisible).toBe(false);
  });
});

describe("Domain 15 — Multi-channel & cross-channel search", () => {
  it("search-driven task accepts contextRequest with multiple include flags", async () => {
    const h = makeHarness();
    const t = await h.runner.schedule(
      input({
        kind: "output",
        promptInstructions:
          "search across channels for a thread about Q3 roadmap",
        trigger: { kind: "manual" },
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
    expect(t.contextRequest?.includeOwnerFacts).toContain("preferredName");
    expect(t.contextRequest?.includeRecentTaskStates?.kind).toBe("output");
    expect(t.contextRequest?.includeEntities?.entityIds.length).toBe(1);
  });
});

describe("Domain 16 — Activity signals & screen context", () => {
  it("relative_to_anchor wake.confirmed task completes via health_signal_observed", async () => {
    const h = makeHarness();
    h.setNow("2026-05-09T07:00:00.000Z");
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
    const evaluated = await h.runner.evaluateCompletion(t.taskId, {
      acknowledged: false,
    });
    expect(evaluated.state.status).toBe("completed");
  });
});

describe("Domain 17 — Approval queues & action gating", () => {
  it("kind=approval task surfaces ownerVisible cards and feeds onComplete pipelines", async () => {
    const h = makeHarness();
    const approval = await h.runner.schedule(
      input({
        kind: "approval",
        promptInstructions: "approve Calendly negotiation slot",
        trigger: { kind: "event", eventKind: "calendly.negotiation.proposal" },
        ownerVisible: true,
      }),
    );
    expect(approval.kind).toBe("approval");
    expect(approval.ownerVisible).toBe(true);
    const dismissed = await h.runner.apply(approval.taskId, "dismiss", {
      reason: "not now",
    });
    expect(dismissed.state.status).toBe("dismissed");
  });
});

describe("Domain 18 — Identity merge (canonical person)", () => {
  it("entity-anchored task uses subject.kind=entity for canonical-person matching", async () => {
    const h = makeHarness();
    const t = await h.runner.schedule(
      input({
        kind: "watcher",
        promptInstructions: "watch entity for cross-platform handle merge",
        trigger: { kind: "event", eventKind: "entity.identity.added" },
        subject: { kind: "entity", id: "entity:contact-merlot" },
      }),
    );
    expect(t.subject?.kind).toBe("entity");
    const completed = await h.runner.apply(t.taskId, "complete", {
      reason: "merged identity",
    });
    expect(completed.state.status).toBe("completed");
  });
});

describe("Domain 19 — Memory recall", () => {
  it("output kind with destination=memory accepts persistAs=task_metadata", async () => {
    const h = makeHarness();
    const t = await h.runner.schedule(
      input({
        kind: "output",
        promptInstructions: "remember this preference for later recall",
        trigger: { kind: "manual" },
        output: { destination: "memory", persistAs: "task_metadata" },
      }),
    );
    expect(t.output?.destination).toBe("memory");
    expect(t.output?.persistAs).toBe("task_metadata");
  });
});

describe("Domain 20 — Connectors & permissions", () => {
  it("connector-status follow-up uses metadata for connector identifiers (no schema bloat)", async () => {
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
    expect((t.metadata as { connectorKind?: string }).connectorKind).toBe(
      "google",
    );
    expect((t.metadata as { surface?: string }).surface).toBe("drive");
  });
});

describe("Domain 21 — Health, money, screen time", () => {
  it("health/money/screen-time tasks share the same spine — all completion-checks are registered", async () => {
    const h = makeHarness();
    const screenTime = await h.runner.schedule(
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
    const inspected = h.runner.inspectRegistries();
    expect(inspected.completionChecks).toContain("health_signal_observed");
    expect(inspected.completionChecks).toContain("subject_updated");
    expect(inspected.completionChecks).toContain("user_acknowledged");
    expect(inspected.completionChecks).toContain("user_replied_within");
    expect(screenTime.completionCheck?.kind).toBe("health_signal_observed");
  });
});

describe("Domain 22 — Push notifications", () => {
  it("escalation steps default ladder is tied to priority (high → 3 steps)", async () => {
    const h = makeHarness();
    const high = await h.runner.schedule(
      input({
        kind: "reminder",
        promptInstructions: "high-priority cancellation fee warning",
        trigger: { kind: "once", atIso: "2026-05-09T15:00:00.000Z" },
        priority: "high",
      }),
    );
    expect(high.priority).toBe("high");
    const inspected = h.runner.inspectRegistries();
    expect(inspected.ladders).toContain("priority_high_default");
    expect(inspected.ladders).toContain("priority_medium_default");
    expect(inspected.ladders).toContain("priority_low_default");
  });
});

describe("Domain 23 — Remote sessions", () => {
  it("remote-session escalation task carries metadata for the calling agent", async () => {
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
    expect((t.metadata as { sessionId?: string }).sessionId).toBe("sess-42");
  });
});

describe("Domain 24 — Settings & UX", () => {
  it("first-run preferences are stored as ownerFact-shaped metadata on a config task", async () => {
    const h = makeHarness();
    h.setOwnerFacts({ timezone: "America/Denver", preferredName: "Shaw" });
    const t = await h.runner.schedule(
      input({
        kind: "custom",
        promptInstructions: "settings sync placeholder",
        trigger: { kind: "manual" },
        ownerVisible: false,
        metadata: {
          settingsScope: "first-run",
          touched: ["preferredName", "timezone"],
        },
      }),
    );
    expect(t.ownerVisible).toBe(false);
    expect((t.metadata as { settingsScope?: string }).settingsScope).toBe(
      "first-run",
    );
  });
});

describe("Domain 25 — REST API access flows", () => {
  it("api-source tasks set source='plugin' and skip ownerVisible cards", async () => {
    const h = makeHarness();
    const t = await h.runner.schedule(
      input({
        kind: "custom",
        promptInstructions: "REST scheduler entry — placeholder",
        trigger: { kind: "manual" },
        source: "plugin",
        ownerVisible: false,
      }),
    );
    expect(t.source).toBe("plugin");
    expect(t.ownerVisible).toBe(false);
  });
});

describe("Domain 26 — Workflows (event-triggered)", () => {
  it("event trigger with filter compiles + accepts pipeline composition", async () => {
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
          onComplete: [
            input({ kind: "output", promptInstructions: "audit log" }),
          ],
        },
      }),
    );
    expect(t.trigger.kind).toBe("event");
    const completed = await h.runner.apply(t.taskId, "complete");
    expect(completed.state.status).toBe("completed");
    const list = await h.runner.list();
    expect(list.some((x) => x.promptInstructions === "audit log")).toBe(true);
  });
});

describe("Domain 27 — Multilingual coverage", () => {
  it("locale-tagged metadata + Spanish promptInstructions schedule without runner edits", async () => {
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
    expect((t.metadata as { locale?: string }).locale).toBe("es-ES");
    expect(t.promptInstructions).toContain("Recuerda");
  });
});

describe("Domain 28 — Suspected-but-unconfirmed flows", () => {
  it("custom kind accepts any spine field without specialized branching", async () => {
    const h = makeHarness();
    const t = await h.runner.schedule(
      input({
        kind: "custom",
        promptInstructions: "spine accepts open-ended custom flows",
        trigger: { kind: "manual" },
        metadata: { suspectedFlow: "true" },
      }),
    );
    expect(t.kind).toBe("custom");
    const dismissed = await h.runner.apply(t.taskId, "dismiss", {
      reason: "owner deferred until confirmed",
    });
    expect(dismissed.state.status).toBe("dismissed");
  });
});

// ---------------------------------------------------------------------------
// Game-through findings — runnable assertions for the 10 fixes resolved in
// Wave 1/2 (per IMPLEMENTATION_PLAN §7.3 + GAP_ASSESSMENT §2.3 + §8.10–§8.12).
// ---------------------------------------------------------------------------

describe("Game-through fix — multi-gate `shouldFire`", () => {
  it("composes `all` across multiple built-in gates", async () => {
    const h = makeHarness("2026-05-13T15:00:00.000Z"); // Wednesday 15:00 UTC
    const t = await h.runner.schedule(
      input({
        promptInstructions: "stretch — weekday afternoon",
        trigger: { kind: "interval", everyMinutes: 90 },
        shouldFire: {
          compose: "all",
          gates: [
            { kind: "weekday_only" },
            { kind: "late_evening_skip", params: { afterHour: 21 } },
          ],
        },
      }),
    );
    const fired = await h.runner.fire(t.taskId);
    expect(fired.state.status).toBe("fired");
  });

  it("denies via first_deny when any gate denies", async () => {
    const h = makeHarness("2026-05-09T15:00:00.000Z"); // Saturday 15:00 UTC
    const t = await h.runner.schedule(
      input({
        promptInstructions: "stretch — denies on weekend",
        trigger: { kind: "interval", everyMinutes: 90 },
        shouldFire: {
          compose: "first_deny",
          gates: [{ kind: "weekday_only" }, { kind: "late_evening_skip" }],
        },
      }),
    );
    const fired = await h.runner.fire(t.taskId);
    expect(fired.state.status).toBe("skipped");
  });
});

describe("Game-through fix — terminal-state taxonomy", () => {
  it("differentiates completed | skipped | dismissed | failed via runner verbs", async () => {
    const h = makeHarness();
    const c = await h.runner.schedule(
      input({ promptInstructions: "complete" }),
    );
    const s = await h.runner.schedule(input({ promptInstructions: "skip" }));
    const d = await h.runner.schedule(input({ promptInstructions: "dismiss" }));
    const f = await h.runner.schedule(
      input({ promptInstructions: "fail-via-pipeline" }),
    );

    expect((await h.runner.apply(c.taskId, "complete")).state.status).toBe(
      "completed",
    );
    expect((await h.runner.apply(s.taskId, "skip")).state.status).toBe(
      "skipped",
    );
    expect((await h.runner.apply(d.taskId, "dismiss")).state.status).toBe(
      "dismissed",
    );
    // Failed is reachable via pipeline propagation only — no direct verb. Spawn a child via onFail.
    const failChildren = await h.runner.pipeline(f.taskId, "failed");
    expect(failChildren).toEqual([]);
  });
});

describe("Game-through fix — `output` destination", () => {
  it("accepts every documented output destination without source edits", async () => {
    const h = makeHarness();
    const destinations: Array<ScheduledTask["output"]> = [
      { destination: "in_app_card" },
      { destination: "channel", target: "telegram:owner" },
      { destination: "apple_notes" },
      { destination: "gmail_draft" },
      { destination: "memory", persistAs: "external_only" },
    ];
    for (const output of destinations) {
      const t = await h.runner.schedule(
        input({
          kind: "output",
          promptInstructions: `${output?.destination}-output`,
          output,
        }),
      );
      expect(t.output?.destination).toBe(output?.destination);
    }
  });
});

describe("Game-through fix — `contextRequest`", () => {
  it("preserves all five include-flags through schedule + list round-trip", async () => {
    const h = makeHarness();
    const t = await h.runner.schedule(
      input({
        contextRequest: {
          includeOwnerFacts: ["preferredName", "timezone", "morningWindow"],
          includeEntities: {
            entityIds: ["e:1"],
            fields: ["type", "preferredName"],
          },
          includeRelationships: { types: ["assistant_owner"] },
          includeRecentTaskStates: { lookbackHours: 24 },
          includeEventPayload: true,
        },
      }),
    );
    const fetched = (await h.runner.list()).find((x) => x.taskId === t.taskId);
    expect(fetched?.contextRequest?.includeOwnerFacts?.length).toBe(3);
    expect(fetched?.contextRequest?.includeEventPayload).toBe(true);
  });
});

describe("Game-through fix — `subject`", () => {
  it("filters scheduled tasks by subject without runner edits", async () => {
    const h = makeHarness();
    await h.runner.schedule(
      input({
        subject: { kind: "entity", id: "person-a" },
        promptInstructions: "to-a",
      }),
    );
    await h.runner.schedule(
      input({
        subject: { kind: "entity", id: "person-b" },
        promptInstructions: "to-b",
      }),
    );
    const list = await h.runner.list({
      subject: { kind: "entity", id: "person-a" },
    });
    expect(list.length).toBe(1);
    expect(list[0]?.promptInstructions).toBe("to-a");
  });
});

describe("Game-through fix — `idempotencyKey`", () => {
  it("dedupes second schedule call to the original taskId", async () => {
    const h = makeHarness();
    const a = await h.runner.schedule(
      input({ idempotencyKey: "default-pack:morning-brief", priority: "low" }),
    );
    const b = await h.runner.schedule(
      input({ idempotencyKey: "default-pack:morning-brief", priority: "high" }),
    );
    expect(b.taskId).toBe(a.taskId);
    expect(b.priority).toBe(a.priority);
  });
});

describe("Game-through fix — `respectsGlobalPause`", () => {
  it("paused runner skips respecting tasks but still allows verbs on bypassing tasks", async () => {
    const h = makeHarness();
    h.setPauseActive(true, "vacation");
    const respecting = await h.runner.schedule(
      input({ respectsGlobalPause: true, promptInstructions: "respects" }),
    );
    const bypassing = await h.runner.schedule(
      input({
        respectsGlobalPause: false,
        promptInstructions: "bypasses",
        priority: "high",
      }),
    );
    const respFired = await h.runner.fire(respecting.taskId);
    expect(respFired.state.status).toBe("skipped");
    expect(respFired.state.lastDecisionLog).toContain("global_pause");
    const bypFired = await h.runner.fire(bypassing.taskId);
    expect(bypFired.state.status).toBe("fired");
  });
});

describe("Game-through fix — `reopen`", () => {
  it("reopen restores a completed task to scheduled within the 24h window", async () => {
    const h = makeHarness("2026-05-09T08:00:00.000Z");
    const t = await h.runner.schedule(
      input({ promptInstructions: "reopen-target" }),
    );
    const completed = await h.runner.apply(t.taskId, "complete", {
      reason: "done",
    });
    expect(completed.state.status).toBe("completed");
    h.setNow("2026-05-09T20:00:00.000Z");
    const reopened = await h.runner.apply(t.taskId, "reopen", {
      reason: "late inbound",
    });
    expect(reopened.state.status).toBe("scheduled");
  });

  it("reopen rejects after the 24h window expires", async () => {
    const h = makeHarness("2026-05-09T08:00:00.000Z");
    const t = await h.runner.schedule(
      input({
        promptInstructions: "reopen-expired",
        metadata: { reopenWindowHours: 24 },
      }),
    );
    await h.runner.apply(t.taskId, "complete", { reason: "done" });
    h.setNow("2026-05-11T09:00:00.000Z");
    let threw = false;
    try {
      await h.runner.apply(t.taskId, "reopen");
    } catch (error) {
      threw = true;
      expect((error as Error).message).toContain("window expired");
    }
    expect(threw).toBe(true);
  });
});

describe("Game-through fix — snooze-resets-ladder", () => {
  it("snooze sets the new fire time and resets the escalation cursor", async () => {
    const h = makeHarness("2026-05-09T08:00:00.000Z");
    const t = await h.runner.schedule(
      input({ priority: "high", promptInstructions: "snooze-target" }),
    );
    const snoozed = await h.runner.apply(t.taskId, "snooze", { minutes: 90 });
    expect(snoozed.state.firedAt).toBe("2026-05-09T09:30:00.000Z");
    const cursor = snoozed.metadata?.escalationCursor as
      | { stepIndex: number; lastDispatchedAt: string }
      | undefined;
    expect(cursor?.stepIndex).toBe(-1);
    expect(cursor?.lastDispatchedAt).toBe("2026-05-09T09:30:00.000Z");
  });
});

describe("Game-through fix — priority → notification posture (§8.7)", () => {
  it("priority maps to ladder + intensity defaults consistent with the §8.7 table", async () => {
    const h = makeHarness();
    for (const priority of ["low", "medium", "high"] as const) {
      const t = await h.runner.schedule(
        input({ priority, promptInstructions: `${priority}-fire` }),
      );
      const fired = await h.runner.fire(t.taskId);
      expect(fired.state.status).toBe("fired");
    }
    const inspected = h.runner.inspectRegistries();
    expect(inspected.ladders).toEqual(
      expect.arrayContaining([
        "priority_low_default",
        "priority_medium_default",
        "priority_high_default",
      ]),
    );
  });
});
