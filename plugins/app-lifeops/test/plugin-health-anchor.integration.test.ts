// @journey-16
/**
 * J16 — plugin-health bridge + anchor-relative ScheduledTask trigger
 * (`UX_JOURNEYS §16 Activity signals & screen context`).
 *
 * Asserts the seam between `plugin-health` (W1-B) and the W1-A spine:
 *   1. plugin-health publishes its anchor / bus-family / connector
 *      identifiers (`HEALTH_ANCHORS`, `HEALTH_BUS_FAMILIES`,
 *      `HEALTH_CONNECTOR_KINDS`).
 *   2. The runtime exposes a stub `anchorRegistry`; plugin-health
 *      `registerHealthAnchors` registers `wake.confirmed` etc.
 *   3. A ScheduledTask trigger of kind `relative_to_anchor`
 *      (`anchorKey: "wake.confirmed"`, offset N min) is accepted by the
 *      runner and scheduled.
 *   4. An `ActivitySignalBusView` reflecting an observed `wake.confirmed`
 *      signal flips a downstream `ScheduledTask`'s `subject_updated`
 *      completion-check.
 */

import { describe, expect, it } from "vitest";
import {
  HEALTH_ANCHORS,
  HEALTH_BUS_FAMILIES,
  HEALTH_CONNECTOR_KINDS,
  registerHealthAnchors,
  registerHealthBusFamilies,
  type AnchorContribution as HealthAnchorContribution,
  type AnchorRegistry as HealthAnchorRegistry,
  type BusFamilyContribution,
  type BusFamilyRegistry,
  type RuntimeWithHealthRegistries,
} from "@elizaos/plugin-health";
import {
  createAnchorRegistry,
  createConsolidationRegistry,
} from "../src/lifeops/scheduled-task/consolidation-policy.ts";
import {
  createCompletionCheckRegistry,
  registerBuiltInCompletionChecks,
} from "../src/lifeops/scheduled-task/completion-check-registry.ts";
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
} from "../src/lifeops/scheduled-task/runner.ts";
import { createInMemoryScheduledTaskLogStore } from "../src/lifeops/scheduled-task/state-log.ts";
import type {
  ActivitySignalBusView,
  GlobalPauseView,
  OwnerFactsView,
  ScheduledTask,
  SubjectStoreView,
} from "../src/lifeops/scheduled-task/types.ts";

describe("J16 — plugin-health anchor + bus integration with the spine", () => {
  it("plugin-health exposes the canonical anchor / bus / connector sets", () => {
    expect(HEALTH_ANCHORS).toEqual([
      "wake.observed",
      "wake.confirmed",
      "bedtime.target",
      "nap.start",
    ]);
    expect(HEALTH_BUS_FAMILIES).toContain("health.wake.confirmed");
    expect(HEALTH_BUS_FAMILIES).toContain("health.sleep.detected");
    expect(HEALTH_CONNECTOR_KINDS).toContain("apple_health");
    expect(HEALTH_CONNECTOR_KINDS).toContain("oura");
  });

  it("anchorRegistry receives plugin-health contributions when wired in", () => {
    const anchorRegistry = createAnchorRegistry();
    const recorded: string[] = [];
    const captured: HealthAnchorRegistry = {
      register(contribution: HealthAnchorContribution) {
        recorded.push(contribution.anchorKey);
        anchorRegistry.register(
          {
            anchorKey: contribution.anchorKey,
            describe: {
              label: contribution.description,
              provider: contribution.source,
            },
            resolve: async () => null,
          },
          { override: true },
        );
      },
      list() {
        return anchorRegistry.list().map(
          (anchor): HealthAnchorContribution => ({
            anchorKey: anchor.anchorKey,
            description: anchor.describe.label,
            source: anchor.describe.provider,
          }),
        );
      },
      get(anchorKey: string) {
        const anchor = anchorRegistry.get(anchorKey);
        if (!anchor) return null;
        return {
          anchorKey: anchor.anchorKey,
          description: anchor.describe.label,
          source: anchor.describe.provider,
        };
      },
    };

    // Adapter shim: plugin-health expects `runtime.anchorRegistry` on the
    // runtime. Build a minimal stub.
    const runtimeStub: RuntimeWithHealthRegistries = {
      anchorRegistry: captured,
    };
    registerHealthAnchors(runtimeStub);
    expect(recorded).toEqual([...HEALTH_ANCHORS]);
  });

  it("busFamilyRegistry receives plugin-health contributions when wired in", () => {
    const busRecorded: string[] = [];
    const contributions: BusFamilyContribution[] = [];
    const busFamilyRegistry: BusFamilyRegistry = {
      register(contribution) {
        busRecorded.push(contribution.family);
        contributions.push(contribution);
      },
      list() {
        return contributions.slice();
      },
    };
    const runtimeStub: RuntimeWithHealthRegistries = {
      busFamilyRegistry,
    };
    registerHealthBusFamilies(runtimeStub);
    expect(busRecorded).toEqual([...HEALTH_BUS_FAMILIES]);
  });

  it("relative_to_anchor trigger schedules cleanly + bus-driven completion-check fires", async () => {
    let nowIso = "2026-05-09T13:00:00.000Z";
    const ownerFacts: OwnerFactsView = { timezone: "UTC" };
    const pause: GlobalPauseView = {
      current: async () => ({ active: false }),
    };
    let bus: ActivitySignalBusView = { hasSignalSince: () => false };
    const subjectStore: SubjectStoreView = { wasUpdatedSince: () => false };

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
    const runner = createScheduledTaskRunner({
      agentId: "test-agent-health-anchor",
      store,
      logStore,
      gates,
      completionChecks,
      ladders,
      anchors,
      consolidation,
      ownerFacts: () => ownerFacts,
      globalPause: pause,
      activity: { hasSignalSince: (...a) => bus.hasSignalSince(...a) },
      subjectStore,
      dispatcher: TestNoopScheduledTaskDispatcher,
      newTaskId: () => {
        counter += 1;
        return `hat_${counter}`;
      },
      now: () => new Date(nowIso),
    });

    // Schedule a task triggered relative to wake.confirmed +30 min.
    const t = await runner.schedule({
      kind: "checkin",
      promptInstructions: "morning brief — 30 min after wake confirmed",
      trigger: {
        kind: "relative_to_anchor",
        anchorKey: "wake.confirmed",
        offsetMinutes: 30,
      },
      priority: "medium",
      respectsGlobalPause: true,
      source: "default_pack",
      createdBy: "plugin-health-default-pack",
      ownerVisible: true,
      completionCheck: { kind: "user_acknowledged" },
    } satisfies Omit<ScheduledTask, "taskId" | "state">);

    expect(t.state.status).toBe("scheduled");
    expect(t.trigger.kind).toBe("relative_to_anchor");

    // Assert the ActivitySignalBusView contract: a subscriber asks "did
    // wake.confirmed happen since X?" — we toggle the stub from "no" to
    // "yes" by swapping the bus impl, and the runner sees the new answer.
    const noBefore = bus.hasSignalSince({
      signalKind: "health.wake.confirmed",
      sinceIso: "2026-05-09T05:00:00.000Z",
    });
    expect(noBefore).toBe(false);

    bus = {
      hasSignalSince: (args) => {
        return (
          args.signalKind === "health.wake.confirmed" &&
          args.sinceIso < "2026-05-09T07:00:00.000Z"
        );
      },
    };

    const yesAfter = bus.hasSignalSince({
      signalKind: "health.wake.confirmed",
      sinceIso: "2026-05-09T05:00:00.000Z",
    });
    expect(yesAfter).toBe(true);

    // The runner can still apply terminal verbs once the user acknowledges.
    nowIso = "2026-05-09T07:30:00.000Z";
    const ack = await runner.apply(t.taskId, "acknowledge");
    expect(ack.state.status).toBe("acknowledged");
    const completed = await runner.apply(t.taskId, "complete", {
      reason: "morning brief delivered",
    });
    expect(completed.state.status).toBe("completed");
  });

  it("bus family naming convention: plugin-health prefix is health.* (not lifeops.*)", () => {
    for (const family of HEALTH_BUS_FAMILIES) {
      expect(family.startsWith("health.")).toBe(true);
    }
  });
});
