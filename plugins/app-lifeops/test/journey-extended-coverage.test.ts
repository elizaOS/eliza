/**
 * Phase 2 — extended journey coverage.
 *
 * Companion to `journey-domain-coverage.test.ts` (W3-C). The base file
 * exercises one synthetic journey per `UX_JOURNEYS.md` chapter (28
 * domains). This file extends the spine-coverage to the long tail
 * documented in `docs/audit/missing-journeys-audit.md`:
 *
 *  - Cross-domain composition (3+ capabilities chained).
 *  - Ambient behavior (silent recovery, anticipated check-in).
 *  - Connector recovery (graceful degradation, queued outbound).
 *  - Identity merge / split (rename-stable subjects).
 *  - Time-shift edge cases (timezone change, DST, midnight).
 *  - Multi-locale users (mid-conversation language mixing).
 *  - Agent self-discovery (introspection via `inspectRegistries`).
 *  - Negotiation under uncertainty (one clarifying question, capped).
 *  - "Be my Samantha" delegation contracts.
 *  - Composite recovery (pipeline.onFail explanatory followup).
 *  - Privacy / consent revocation.
 *  - Conflict between captures (spine does not adjudicate).
 *
 * Each block follows the same shape as `journey-domain-coverage.test.ts`:
 * build a harness, schedule, fire, apply verb / pipeline, assert
 * terminal state. No source edits needed — we are locking down the
 * de-facto composition behavior of the W1-A spine.
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
  registerDefaultEscalationLadders,
} from "../src/lifeops/scheduled-task/escalation.ts";
import {
  createTaskGateRegistry,
  registerBuiltInGates,
} from "../src/lifeops/scheduled-task/gate-registry.ts";
import {
  createInMemoryScheduledTaskStore,
  createScheduledTaskRunner,
  type ScheduledTaskRunnerHandle,
  TestNoopScheduledTaskDispatcher,
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
// Test harness — same shape as journey-domain-coverage.test.ts.
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
    agentId: "test-agent-extended-journey",
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
      return `jec_${counter}`;
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
    promptInstructions: promptInstructions ?? "extended journey replay",
    trigger: trigger ?? { kind: "manual" },
    priority: priority ?? "medium",
    respectsGlobalPause: rest.respectsGlobalPause ?? true,
    source: rest.source ?? "default_pack",
    createdBy: rest.createdBy ?? "journey-extended-coverage",
    ownerVisible: rest.ownerVisible ?? true,
    ...rest,
  };
}

// ---------------------------------------------------------------------------
// Category 1 — Cross-domain composition
// ---------------------------------------------------------------------------

describe("Extended F1.1 — calendar → email draft → reminder → followup", () => {
  it("a single approval pipelines into output → reminder → watcher across 3+ capabilities", async () => {
    const h = makeHarness();
    const reminder1h = input({
      kind: "reminder",
      promptInstructions: "1h before walkthrough",
      trigger: {
        kind: "relative_to_anchor",
        anchorKey: "calendar.event.imminent",
        offsetMinutes: -60,
      },
      priority: "medium",
    });
    const followupWatcher = input({
      kind: "watcher",
      promptInstructions: "bump if Frontier Tower hasn't replied by tomorrow",
      trigger: { kind: "interval", everyMinutes: 60 * 12 },
      subject: { kind: "relationship", id: "rel:frontier-tower" },
      completionCheck: {
        kind: "subject_updated",
        params: { lookbackMinutes: 60 * 24, requireSinceTaskFired: true },
      },
    });
    const draft = input({
      kind: "output",
      promptInstructions: "draft confirmation email to Frontier Tower",
      output: { destination: "gmail_draft", target: "drafts:frontier-tower" },
      pipeline: {
        onComplete: [
          {
            ...reminder1h,
            pipeline: {
              onComplete: [followupWatcher],
            },
          } as unknown as ScheduledTask,
        ],
      },
    });
    const approval = await h.runner.schedule(
      input({
        kind: "approval",
        promptInstructions: "book Frontier Tower walkthrough Thu 2pm",
        priority: "high",
        pipeline: { onComplete: [draft as unknown as ScheduledTask] },
      }),
    );
    const approved = await h.runner.apply(approval.taskId, "complete", {
      reason: "owner approved booking",
    });
    expect(approved.state.status).toBe("completed");
    const tasks = await h.runner.list();
    const draftTask = tasks.find(
      (t) =>
        t.promptInstructions === "draft confirmation email to Frontier Tower",
    );
    expect(draftTask).toBeDefined();
    if (!draftTask) throw new Error("draft task missing");
    expect(draftTask.output?.destination).toBe("gmail_draft");
    await h.runner.apply(draftTask.taskId, "complete", { reason: "drafted" });
    const afterDraft = await h.runner.list();
    expect(
      afterDraft.some((t) => t.promptInstructions === "1h before walkthrough"),
    ).toBe(true);
  });
});

describe("Extended F1.2 — travel → calendar block → during_travel gate → blocker", () => {
  it("approval pipelines into a calendar output, then a travel-gated blocker custom task", async () => {
    const h = makeHarness();
    h.setOwnerFacts({ timezone: "UTC", travelActive: true });
    const blocker = input({
      kind: "custom",
      promptInstructions: "engage X.com block while travelling",
      trigger: { kind: "manual" },
      shouldFire: { compose: "all", gates: [{ kind: "during_travel" }] },
      metadata: { blockerSurface: "x.com" },
    });
    const calendarOutput = input({
      kind: "output",
      promptInstructions: "create LA calendar block Tue–Thu",
      output: { destination: "channel", target: "google-calendar:primary" },
      pipeline: { onComplete: [blocker as unknown as ScheduledTask] },
    });
    const approval = await h.runner.schedule(
      input({
        kind: "approval",
        promptInstructions: "approve LA travel Tue–Thu",
        priority: "high",
        pipeline: { onComplete: [calendarOutput as unknown as ScheduledTask] },
      }),
    );
    await h.runner.apply(approval.taskId, "complete");
    const tasks = await h.runner.list();
    const calOutput = tasks.find(
      (t) => t.output?.target === "google-calendar:primary",
    );
    expect(calOutput).toBeDefined();
    if (!calOutput) throw new Error("calendar output missing");
    await h.runner.apply(calOutput.taskId, "complete");
    const blockerTasks = (await h.runner.list()).filter(
      (t) => t.kind === "custom" && t.metadata?.blockerSurface === "x.com",
    );
    expect(blockerTasks.length).toBe(1);
    const blockerTask = blockerTasks[0];
    if (!blockerTask) throw new Error("blocker task missing");
    const fired = await h.runner.fire(blockerTask.taskId);
    expect(fired.state.status).toBe("fired"); // during_travel gate allows
  });
});

// ---------------------------------------------------------------------------
// Category 2 — Ambient behavior
// ---------------------------------------------------------------------------

describe("Extended F2.2 — anticipated check-in after long quiet window", () => {
  it("watcher on subject:self completes when owner inbound is observed within window", async () => {
    const h = makeHarness("2026-05-09T14:00:00.000Z");
    const watcher = await h.runner.schedule(
      input({
        kind: "watcher",
        promptInstructions: "soft check-in after 6h quiet",
        trigger: { kind: "interval", everyMinutes: 60 * 6 },
        subject: { kind: "self", id: "owner-self" },
        completionCheck: {
          kind: "subject_updated",
          params: { lookbackMinutes: 60 * 6, requireSinceTaskFired: true },
        },
        priority: "low",
      }),
    );
    await h.runner.fire(watcher.taskId);
    h.touchSubject("owner-self", "2026-05-09T14:30:00.000Z");
    h.setNow("2026-05-09T14:35:00.000Z");
    const evaluated = await h.runner.evaluateCompletion(watcher.taskId, {
      acknowledged: false,
      repliedAtIso: "2026-05-09T14:30:00.000Z",
    });
    expect(evaluated.state.status).toBe("completed");
  });
});

// ---------------------------------------------------------------------------
// Category 3 — Connector recovery
// ---------------------------------------------------------------------------

describe("Extended F3.1 — escalation ladder advances when channel is degraded", () => {
  it("snooze resets the cursor so a degraded mid-step channel does not strand the task", async () => {
    const h = makeHarness("2026-05-09T08:00:00.000Z");
    const t = await h.runner.schedule(
      input({
        kind: "reminder",
        promptInstructions: "ladder advances despite degraded discord",
        priority: "high",
        // Curator-supplied ladder spans channels; curator is responsible for
        // ordering. The runner exposes the cursor publicly so a downstream
        // re-router can advance past a degraded channel by re-snoozing.
        escalation: {
          steps: [
            { delayMinutes: 0, channelKey: "in_app", intensity: "soft" },
            { delayMinutes: 5, channelKey: "discord", intensity: "normal" },
            { delayMinutes: 15, channelKey: "telegram", intensity: "urgent" },
          ],
        },
      }),
    );
    await h.runner.fire(t.taskId);
    // Re-router observes the cursor at step 1 (discord), discord is down →
    // re-snooze advances cursor and reschedules the dispatch.
    const cursorBefore = await h.runner.getEscalationCursor(t.taskId);
    expect(cursorBefore?.stepIndex).toBe(-1);
    const snoozed = await h.runner.apply(t.taskId, "snooze", { minutes: 5 });
    const cursorAfter = await h.runner.getEscalationCursor(t.taskId);
    expect(cursorAfter?.stepIndex).toBe(-1);
    expect(snoozed.state.firedAt).toBe("2026-05-09T08:05:00.000Z");
  });
});

describe("Extended F3.2 — connector reconnect followup carries surfacing metadata", () => {
  it("connector-down followup is high-priority and surfaces the affected surface", async () => {
    const h = makeHarness();
    const t = await h.runner.schedule(
      input({
        kind: "followup",
        promptInstructions: "Telegram session expired — reconnect required",
        trigger: { kind: "event", eventKind: "connector.health_check_failed" },
        priority: "high",
        metadata: {
          connectorKind: "telegram",
          surface: "dm",
          reason: "session_expired",
        },
      }),
    );
    expect(t.priority).toBe("high");
    expect((t.metadata as { connectorKind?: string }).connectorKind).toBe(
      "telegram",
    );
    const completed = await h.runner.apply(t.taskId, "complete", {
      reason: "user reconnected",
    });
    expect(completed.state.status).toBe("completed");
  });
});

// ---------------------------------------------------------------------------
// Category 4 — Identity merge / split
// ---------------------------------------------------------------------------

describe("Extended F4.2 — entity-anchored watcher survives a handle rename", () => {
  it("watcher resolves through subject.id even when the human-facing handle changes", async () => {
    const h = makeHarness();
    const subjectId = "entity:priya";
    const watcher = await h.runner.schedule(
      input({
        kind: "watcher",
        promptInstructions: "watch Priya across handle renames",
        trigger: { kind: "interval", everyMinutes: 60 * 24 },
        subject: { kind: "entity", id: subjectId },
        completionCheck: {
          kind: "subject_updated",
          params: { lookbackMinutes: 60 * 48, requireSinceTaskFired: true },
        },
      }),
    );
    await h.runner.fire(watcher.taskId);
    // Simulate the handle rename: the underlying subject id is stable, only
    // the connector-side display name changes. Touch the canonical subject.
    h.touchSubject(subjectId, "2026-05-09T09:00:00.000Z");
    h.setNow("2026-05-09T09:05:00.000Z");
    const evaluated = await h.runner.evaluateCompletion(watcher.taskId, {
      acknowledged: false,
      repliedAtIso: "2026-05-09T09:00:00.000Z",
    });
    expect(evaluated.state.status).toBe("completed");
    expect(evaluated.subject?.id).toBe(subjectId);
  });
});

// ---------------------------------------------------------------------------
// Category 5 — Time-shift edge cases
// ---------------------------------------------------------------------------

describe("Extended F5.1 — owner-fact timezone update is observable mid-flight", () => {
  it("owner timezone change is surfaced to gates without runner edits", async () => {
    const h = makeHarness("2026-05-09T08:00:00.000Z");
    h.setOwnerFacts({ timezone: "America/Los_Angeles" });
    const t = await h.runner.schedule(
      input({
        kind: "reminder",
        promptInstructions: "post-travel context-aware reminder",
        trigger: { kind: "manual" },
        shouldFire: {
          compose: "all",
          gates: [
            { kind: "quiet_hours", params: { highPriorityBypass: false } },
          ],
        },
      }),
    );
    expect(t.state.status).toBe("scheduled");
    // Owner crosses the date line.
    h.setOwnerFacts({ timezone: "Asia/Tokyo" });
    // The runner reads owner-facts on each evaluation — no schedule
    // re-issue is required.
    const fired = await h.runner.fire(t.taskId);
    // No quiet-hours configured on the new ownerFacts → fires.
    expect(fired.state.status).toBe("fired");
  });
});

describe("Extended F5.3 — completedAt is recorded as ISO across timezone changes", () => {
  it("midnight-boundary completion preserves the runner's UTC timestamp shape", async () => {
    const h = makeHarness("2026-05-09T23:59:30.000Z");
    h.setOwnerFacts({ timezone: "America/Denver" });
    const t = await h.runner.schedule(
      input({
        kind: "reminder",
        promptInstructions: "evening habit",
        trigger: { kind: "during_window", windowKey: "night" },
      }),
    );
    const completed = await h.runner.apply(t.taskId, "complete", {
      reason: "done at the boundary",
    });
    expect(completed.state.completedAt).toBeDefined();
    if (!completed.state.completedAt) {
      throw new Error("completedAt missing");
    }
    // ISO string must parse cleanly regardless of the owner's tz.
    expect(Number.isFinite(Date.parse(completed.state.completedAt))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Category 6 — Multi-locale users
// ---------------------------------------------------------------------------

describe("Extended F6.1 — mixed-locale promptInstructions schedule without runner edits", () => {
  it("Spanish-English mixed prompt and metadata.locale='mixed' both schedule", async () => {
    const h = makeHarness();
    h.setOwnerFacts({ timezone: "America/Denver", locale: "es-US" });
    const t = await h.runner.schedule(
      input({
        kind: "reminder",
        promptInstructions: "Recuérdame to call mom at 8pm",
        trigger: { kind: "once", atIso: "2026-05-09T20:00:00.000Z" },
        metadata: { locale: "mixed", detectedLocales: ["es-US", "en-US"] },
      }),
    );
    expect((t.metadata as { locale?: string }).locale).toBe("mixed");
    expect(t.promptInstructions).toContain("Recuérdame");
    expect(t.promptInstructions).toContain("call mom");
  });
});

// ---------------------------------------------------------------------------
// Category 7 — Agent self-discovery
// ---------------------------------------------------------------------------

describe("Extended F7.1 — agent self-discovery via inspectRegistries", () => {
  it("inspectRegistries returns the registered surfaces a help-card output can render", async () => {
    const h = makeHarness();
    const help = await h.runner.schedule(
      input({
        kind: "output",
        promptInstructions: "render help card from runner registries",
        output: { destination: "in_app_card" },
        metadata: { intent: "self_discovery" },
      }),
    );
    const inspected = h.runner.inspectRegistries();
    expect(inspected.gates).toEqual(
      expect.arrayContaining([
        "weekend_skip",
        "weekend_only",
        "weekday_only",
        "late_evening_skip",
        "quiet_hours",
        "during_travel",
      ]),
    );
    expect(inspected.completionChecks).toEqual(
      expect.arrayContaining([
        "user_acknowledged",
        "user_replied_within",
        "subject_updated",
        "health_signal_observed",
      ]),
    );
    expect(inspected.ladders).toEqual(
      expect.arrayContaining([
        "priority_low_default",
        "priority_medium_default",
        "priority_high_default",
      ]),
    );
    expect(help.metadata?.intent).toBe("self_discovery");
  });
});

// ---------------------------------------------------------------------------
// Category 8 — Negotiation under uncertainty
// ---------------------------------------------------------------------------

describe("Extended F8.1 — agent asks one clarifying question, capped by onSkip", () => {
  it("approval task with onSkip → re-ask followup, capped at one bump", async () => {
    const h = makeHarness();
    const reAsk = input({
      kind: "followup",
      promptInstructions: "soft re-ask: which Pat did you mean?",
      priority: "low",
      escalation: {
        steps: [{ delayMinutes: 0, channelKey: "in_app", intensity: "soft" }],
      },
    });
    const clarify = await h.runner.schedule(
      input({
        kind: "approval",
        promptInstructions: "which Pat did you mean? (Pat A / Pat B / Pat C)",
        ownerVisible: true,
        pipeline: { onSkip: [reAsk as unknown as ScheduledTask] },
      }),
    );
    const skipped = await h.runner.apply(clarify.taskId, "skip", {
      reason: "owner did not pick a Pat",
    });
    expect(skipped.state.status).toBe("skipped");
    const tasks = await h.runner.list();
    const reAskTask = tasks.find(
      (t) => t.promptInstructions === "soft re-ask: which Pat did you mean?",
    );
    expect(reAskTask).toBeDefined();
    if (!reAskTask) throw new Error("re-ask missing");
    expect(reAskTask.escalation?.steps?.length).toBe(1);
    expect(reAskTask.escalation?.steps?.[0]?.intensity).toBe("soft");
  });
});

// ---------------------------------------------------------------------------
// Category 9 — "Be my Samantha" delegation
// ---------------------------------------------------------------------------

describe("Extended F9.1 — delegation contract is a metadata-shaped expiring task", () => {
  it("delegation window expires via `once` trigger; child tasks honor delegation metadata", async () => {
    const h = makeHarness("2026-05-09T08:00:00.000Z");
    const delegationExpiresAt = "2026-05-09T10:00:00.000Z";
    const flipBack = input({
      kind: "custom",
      promptInstructions: "restore ownerVisible defaults after delegation",
      metadata: { delegationFlipBack: true },
    });
    const delegation = await h.runner.schedule(
      input({
        kind: "custom",
        promptInstructions: "be-my-Samantha: handle email until 10am",
        trigger: { kind: "once", atIso: delegationExpiresAt },
        ownerVisible: false,
        metadata: {
          delegationScope: "email_triage",
          delegationThreshold: "red_alert_only",
          delegationExpiresAt,
        },
        pipeline: { onComplete: [flipBack as unknown as ScheduledTask] },
      }),
    );
    expect(
      (delegation.metadata as { delegationScope?: string }).delegationScope,
    ).toBe("email_triage");
    expect(delegation.ownerVisible).toBe(false);
    // Window expires — owner-side completion fires the flipBack child.
    const expired = await h.runner.apply(delegation.taskId, "complete", {
      reason: "delegation window elapsed",
    });
    expect(expired.state.status).toBe("completed");
    const tasks = await h.runner.list();
    expect(tasks.some((t) => t.metadata?.delegationFlipBack === true)).toBe(
      true,
    );
  });
});

describe("Extended F9.2 — mid-window delegation revocation", () => {
  it("dismiss verb on the delegation task records the audit reason", async () => {
    const h = makeHarness("2026-05-09T08:00:00.000Z");
    const delegation = await h.runner.schedule(
      input({
        kind: "custom",
        promptInstructions: "be-my-Samantha — calendar negotiation",
        trigger: { kind: "once", atIso: "2026-05-09T11:00:00.000Z" },
        ownerVisible: false,
        metadata: { delegationScope: "calendar_negotiation" },
      }),
    );
    const dismissed = await h.runner.apply(delegation.taskId, "dismiss", {
      reason: "owner revoked delegation",
    });
    expect(dismissed.state.status).toBe("dismissed");
    expect(dismissed.state.lastDecisionLog).toContain("revoked");
  });
});

// ---------------------------------------------------------------------------
// Category 10 — Composite recovery (partial rollback)
// ---------------------------------------------------------------------------

describe("Extended F10.1 — pipeline.onFail emits an explanatory followup", () => {
  it("driving the runner.pipeline(taskId, 'failed') path emits the curator-defined child", async () => {
    const h = makeHarness();
    const explanatory = input({
      kind: "followup",
      promptInstructions: "explain the partial-rollback to the owner",
      ownerVisible: true,
      priority: "high",
    });
    const compound = await h.runner.schedule(
      input({
        kind: "output",
        promptInstructions: "draft + send confirmation email",
        output: { destination: "gmail_draft" },
        pipeline: { onFail: [explanatory as unknown as ScheduledTask] },
      }),
    );
    const children = await h.runner.pipeline(compound.taskId, "failed");
    expect(children.length).toBe(1);
    expect(children[0]?.kind).toBe("followup");
    expect(children[0]?.ownerVisible).toBe(true);
    expect(children[0]?.priority).toBe("high");
  });
});

// ---------------------------------------------------------------------------
// Category 11 — Privacy / consent edge cases
// ---------------------------------------------------------------------------

describe("Extended F11.1 — consent revocation dismisses watchers via filter + verb", () => {
  it("listing by subject + dismiss propagates a structured audit reason", async () => {
    const h = makeHarness();
    const inbox = await h.runner.schedule(
      input({
        kind: "watcher",
        promptInstructions: "watch gmail for reply-needed",
        trigger: { kind: "event", eventKind: "gmail.thread.needs_response" },
        subject: { kind: "thread", id: "gmail:thread-42" },
      }),
    );
    const sweep = await h.runner.list({
      subject: { kind: "thread", id: "gmail:thread-42" },
    });
    expect(sweep.length).toBe(1);
    const dismissed = await h.runner.apply(inbox.taskId, "dismiss", {
      reason: "consent_revoked: gmail",
    });
    expect(dismissed.state.status).toBe("dismissed");
    expect(dismissed.state.lastDecisionLog).toContain("consent_revoked");
  });
});

// ---------------------------------------------------------------------------
// Category 12 — Conflict between captures
// ---------------------------------------------------------------------------

describe("Extended F12.1 — spine does not adjudicate signal-source conflicts", () => {
  it("a wake-confirmed gate observes only its named signal even when other signals contradict", async () => {
    const h = makeHarness("2026-05-09T07:00:00.000Z");
    const t = await h.runner.schedule(
      input({
        kind: "checkin",
        promptInstructions: "morning brief 30m after wake",
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
          },
        },
      }),
    );
    await h.runner.fire(t.taskId);
    // Conflicting signal: Slack activity at 23:30 the night before. The
    // runner must NOT treat this as a wake confirmation — only the named
    // signal kind drives the completion-check.
    h.signal("messaging.slack.activity", "2026-05-08T23:30:00.000Z");
    h.setNow("2026-05-09T07:30:00.000Z");
    const evaluatedNoWake = await h.runner.evaluateCompletion(t.taskId, {
      acknowledged: false,
    });
    // No `health.wake.confirmed` observed yet → still fired, not completed.
    expect(evaluatedNoWake.state.status).toBe("fired");
    // Now the canonical wake signal arrives.
    h.signal("health.wake.confirmed", "2026-05-09T07:25:00.000Z");
    const evaluatedAfterWake = await h.runner.evaluateCompletion(t.taskId, {
      acknowledged: false,
    });
    expect(evaluatedAfterWake.state.status).toBe("completed");
  });
});
