/**
 * Class-level standing guarantees — unit tests (#14864). The ScheduledTask
 * runner is mocked so the tests pin the structural contract: an installed
 * guarantee is an event-triggered task keyed by obligation class; a newly
 * observed matching artifact adds an idempotent lead-time warn watcher and
 * fires the obligation event; non-matching artifacts change nothing.
 */

import type { IAgentRuntime, UUID } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  schedule: vi.fn(),
  list: vi.fn(async (): Promise<unknown[]> => []),
}));

vi.mock("../src/lifeops/scheduled-task/service.js", () => ({
  getScheduledTaskRunner: () => ({
    schedule: mocks.schedule,
    list: mocks.list,
    apply: vi.fn(),
    pipeline: vi.fn(),
  }),
}));

import {
  applyCommitmentClassGuarantees,
  installCommitmentClassGuarantee,
  normalizeObligationClass,
} from "../src/lifeops/commitments/standing-guarantees.js";

const DAY_MS = 24 * 60 * 60 * 1000;

function makeRuntime(emitEvent = vi.fn(async () => undefined)): {
  runtime: IAgentRuntime;
  emitEvent: ReturnType<typeof vi.fn>;
} {
  return {
    runtime: {
      agentId: "agent-guarantee-test" as UUID,
      emitEvent,
    } as unknown as IAgentRuntime,
    emitEvent,
  };
}

function guaranteeTask(warnDaysBefore?: number) {
  return {
    taskId: "guarantee-renewal",
    kind: "watcher",
    trigger: {
      kind: "event",
      eventKind: "document.obligation.observed",
      filter: { obligationKind: "renewal" },
    },
    metadata: {
      standingGuarantee: true,
      obligationClass: "renewal",
      ...(warnDaysBefore ? { warnDaysBefore } : {}),
    },
    state: { status: "scheduled", followupCount: 0 },
  };
}

describe("commitment standing guarantees", () => {
  beforeEach(() => {
    mocks.schedule
      .mockReset()
      .mockImplementation(async (task: { trigger: unknown }) => ({
        taskId: `task-${mocks.schedule.mock.calls.length}`,
        ...task,
        state: { status: "scheduled", followupCount: 0 },
      }));
    mocks.list.mockReset().mockResolvedValue([]);
  });

  describe("normalizeObligationClass", () => {
    it("accepts the four typed classes case-insensitively", () => {
      expect(normalizeObligationClass("Renewal")).toBe("renewal");
      expect(normalizeObligationClass(" filing ")).toBe("filing");
    });

    it("rejects unknown classes and non-strings", () => {
      expect(normalizeObligationClass("vibes")).toBeNull();
      expect(normalizeObligationClass(42)).toBeNull();
    });
  });

  describe("installCommitmentClassGuarantee", () => {
    it("schedules an event-triggered task keyed per class", async () => {
      const { runtime } = makeRuntime();
      await installCommitmentClassGuarantee(runtime, {
        agentId: "agent-guarantee-test",
        obligationClass: "renewal",
      });
      expect(mocks.schedule).toHaveBeenCalledTimes(1);
      expect(mocks.schedule.mock.calls[0]?.[0]).toMatchObject({
        kind: "watcher",
        trigger: {
          kind: "event",
          eventKind: "document.obligation.observed",
          filter: { obligationKind: "renewal" },
        },
        idempotencyKey: "commitment-guarantee:renewal",
        metadata: { standingGuarantee: true, warnDaysBefore: 60 },
      });
    });
  });

  describe("applyCommitmentClassGuarantees", () => {
    const artifact = {
      documentId: "doc-msa-1",
      title: "Vendor MSA",
      deadline: new Date(Date.now() + 120 * DAY_MS).toISOString(),
      obligationKind: "renewal" as const,
    };

    it("does nothing when no guarantee covers the class", async () => {
      const { runtime, emitEvent } = makeRuntime();
      const result = await applyCommitmentClassGuarantees(runtime, {
        agentId: "agent-guarantee-test",
        artifact,
      });
      expect(result).toEqual({ matchedGuaranteeTaskIds: [], warnTaskIds: [] });
      expect(mocks.schedule).not.toHaveBeenCalled();
      expect(emitEvent).not.toHaveBeenCalled();
    });

    it("schedules the 60-day warn watcher and fires the obligation event", async () => {
      mocks.list.mockResolvedValue([guaranteeTask()]);
      const { runtime, emitEvent } = makeRuntime();
      const result = await applyCommitmentClassGuarantees(runtime, {
        agentId: "agent-guarantee-test",
        artifact,
      });
      expect(result.matchedGuaranteeTaskIds).toEqual(["guarantee-renewal"]);
      expect(result.warnTaskIds).toHaveLength(1);
      const scheduled = mocks.schedule.mock.calls[0]?.[0] as {
        trigger: { kind: string; atIso: string };
        idempotencyKey: string;
      };
      expect(scheduled.trigger.kind).toBe("once");
      expect(scheduled.trigger.atIso).toBe(
        new Date(Date.parse(artifact.deadline) - 60 * DAY_MS).toISOString(),
      );
      expect(scheduled.idempotencyKey).toBe(
        `commitment-warn:${artifact.documentId}:${artifact.deadline}:60`,
      );
      expect(emitEvent).toHaveBeenCalledWith(
        "document.obligation.observed",
        expect.objectContaining({
          obligationKind: "renewal",
          documentId: artifact.documentId,
        }),
      );
    });

    it("honors a custom warn lead time from the guarantee metadata", async () => {
      mocks.list.mockResolvedValue([guaranteeTask(30)]);
      const { runtime } = makeRuntime();
      await applyCommitmentClassGuarantees(runtime, {
        agentId: "agent-guarantee-test",
        artifact,
      });
      const scheduled = mocks.schedule.mock.calls[0]?.[0] as {
        trigger: { atIso: string };
      };
      expect(scheduled.trigger.atIso).toBe(
        new Date(Date.parse(artifact.deadline) - 30 * DAY_MS).toISOString(),
      );
    });

    it("skips the warn watcher when the lead time is already past but still fires the event", async () => {
      mocks.list.mockResolvedValue([guaranteeTask()]);
      const { runtime, emitEvent } = makeRuntime();
      const result = await applyCommitmentClassGuarantees(runtime, {
        agentId: "agent-guarantee-test",
        artifact: {
          ...artifact,
          deadline: new Date(Date.now() + 10 * DAY_MS).toISOString(),
        },
      });
      expect(result.warnTaskIds).toHaveLength(0);
      expect(mocks.schedule).not.toHaveBeenCalled();
      expect(emitEvent).toHaveBeenCalledTimes(1);
    });

    it("ignores guarantees for a different obligation class", async () => {
      mocks.list.mockResolvedValue([guaranteeTask()]);
      const { runtime, emitEvent } = makeRuntime();
      const result = await applyCommitmentClassGuarantees(runtime, {
        agentId: "agent-guarantee-test",
        artifact: { ...artifact, obligationKind: "warranty" },
      });
      expect(result.matchedGuaranteeTaskIds).toHaveLength(0);
      expect(emitEvent).not.toHaveBeenCalled();
    });

    it("throws on an unparseable artifact deadline", async () => {
      mocks.list.mockResolvedValue([guaranteeTask()]);
      const { runtime } = makeRuntime();
      await expect(
        applyCommitmentClassGuarantees(runtime, {
          agentId: "agent-guarantee-test",
          artifact: { ...artifact, deadline: "whenever" },
        }),
      ).rejects.toThrow(/unparseable deadline/);
    });
  });
});
