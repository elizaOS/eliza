/**
 * `CONFLICT_DETECT` umbrella action — unit tests (W2-5).
 *
 * Wave-1 scaffold. Asserts that the proactive calendar-conflict surface
 * exists, detects overlaps from the injected loader, and evaluates a
 * proposed event window against the feed.
 */

import type {
  HandlerOptions,
  IAgentRuntime,
  Memory,
  UUID,
} from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  hasOwnerAccess: vi.fn(async () => true),
}));

vi.mock("@elizaos/agent", () => ({
  hasOwnerAccess: mocks.hasOwnerAccess,
}));

import {
  __resetConflictDetectLoaderForTests,
  type ConflictDetectEvent,
  conflictDetectAction,
  setConflictDetectLoader,
} from "../src/actions/conflict-detect.js";

function makeRuntime(): IAgentRuntime {
  return {
    agentId: "agent-conflict-test" as UUID,
    logger: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      debug: () => undefined,
    },
  } as unknown as IAgentRuntime;
}

function makeMessage(text = "any conflicts today?"): Memory {
  return {
    id: "msg-conflict-1" as UUID,
    entityId: "owner-1" as UUID,
    roomId: "room-conflict-1" as UUID,
    content: { text },
  } as Memory;
}

async function callConflict(
  runtime: IAgentRuntime,
  message: Memory,
  parameters: Record<string, unknown>,
) {
  return conflictDetectAction.handler(
    runtime,
    message,
    undefined,
    { parameters } as unknown as HandlerOptions,
    async () => undefined,
  );
}

const FEED_WITH_OVERLAP: readonly ConflictDetectEvent[] = [
  {
    id: "evt-a",
    title: "Board sync",
    startISO: "2026-05-11T09:00:00.000Z",
    endISO: "2026-05-11T10:00:00.000Z",
    attendees: ["alice@example.com"],
  },
  {
    id: "evt-b",
    title: "Standup",
    startISO: "2026-05-11T09:30:00.000Z",
    endISO: "2026-05-11T10:30:00.000Z",
    attendees: ["alice@example.com"],
  },
  {
    id: "evt-c",
    title: "Standup outside",
    startISO: "2026-05-11T11:00:00.000Z",
    endISO: "2026-05-11T11:30:00.000Z",
    attendees: ["bob@example.com"],
  },
];

describe("CONFLICT_DETECT umbrella action — proactive calendar scans", () => {
  beforeEach(() => {
    __resetConflictDetectLoaderForTests();
    mocks.hasOwnerAccess.mockReset().mockResolvedValue(true);
  });

  describe("metadata", () => {
    it("exposes the canonical name and PRD similes", () => {
      expect(conflictDetectAction.name).toBe("CONFLICT_DETECT");
      const similes = conflictDetectAction.similes ?? [];
      for (const required of [
        "CONFLICT_DETECT",
        "FIND_CONFLICTS",
        "CHECK_CONFLICTS",
        "CALENDAR_CONFLICTS",
      ]) {
        expect(similes).toContain(required);
      }
    });

    it("rejects calls with no subaction selector", async () => {
      const result = await callConflict(makeRuntime(), makeMessage(), {});
      expect(result.success).toBe(false);
      expect(result.data).toMatchObject({ error: "MISSING_SUBACTION" });
    });

    it("rejects callers that fail the owner-access check", async () => {
      mocks.hasOwnerAccess.mockResolvedValueOnce(false);
      const result = await callConflict(makeRuntime(), makeMessage(), {
        subaction: "scan_today",
      });
      expect(result.success).toBe(false);
      expect(result.data).toMatchObject({ error: "PERMISSION_DENIED" });
    });
  });

  describe("scan_today", () => {
    it("finds overlapping events and marks shared-attendee overlaps as hard", async () => {
      setConflictDetectLoader({
        loadFeed: async () => FEED_WITH_OVERLAP,
      });
      const result = await callConflict(makeRuntime(), makeMessage(), {
        subaction: "scan_today",
      });
      expect(result.success).toBe(true);
      const data = result.data as {
        conflicts: {
          eventA: { id: string };
          eventB: { id: string };
          severity: string;
        }[];
        summary: string;
        checkedEvents: number;
      };
      expect(data.conflicts).toHaveLength(1);
      expect(data.conflicts[0]).toMatchObject({ severity: "hard" });
      expect(
        new Set([data.conflicts[0]!.eventA.id, data.conflicts[0]!.eventB.id]),
      ).toEqual(new Set(["evt-a", "evt-b"]));
      expect(data.checkedEvents).toBe(3);
    });

    it("returns no conflicts when the feed is empty", async () => {
      setConflictDetectLoader({ loadFeed: async () => [] });
      const result = await callConflict(makeRuntime(), makeMessage(), {
        subaction: "scan_today",
      });
      expect(result.success).toBe(true);
      const data = result.data as { conflicts: unknown[]; summary: string };
      expect(data.conflicts).toHaveLength(0);
      expect(data.summary).toBe("No conflicts detected.");
    });
  });

  describe("scan_week", () => {
    it("uses a 7-day range by default", async () => {
      const seen: Array<{ start: string; end: string }> = [];
      setConflictDetectLoader({
        loadFeed: async ({ range }) => {
          seen.push(range);
          return [];
        },
      });
      const result = await callConflict(makeRuntime(), makeMessage(), {
        subaction: "scan_week",
      });
      expect(result.success).toBe(true);
      expect(seen).toHaveLength(1);
      const [{ start, end }] = seen;
      expect(start).toBeTruthy();
      expect(end).toBeTruthy();
      const days =
        (Date.parse(end!) - Date.parse(start!)) / (24 * 60 * 60 * 1000);
      expect(days).toBeGreaterThanOrEqual(6.9);
      expect(days).toBeLessThanOrEqual(8.1);
    });

    it("flags warning-only severity for overlap without shared attendees", async () => {
      setConflictDetectLoader({
        loadFeed: async () => [
          {
            id: "evt-1",
            title: "Solo block",
            startISO: "2026-05-12T14:00:00.000Z",
            endISO: "2026-05-12T15:00:00.000Z",
            attendees: ["self@example.com"],
          },
          {
            id: "evt-2",
            title: "Phone call",
            startISO: "2026-05-12T14:30:00.000Z",
            endISO: "2026-05-12T15:30:00.000Z",
            attendees: ["external@example.com"],
          },
        ],
      });
      const result = await callConflict(makeRuntime(), makeMessage(), {
        subaction: "scan_week",
      });
      const data = result.data as { conflicts: { severity: string }[] };
      expect(data.conflicts).toHaveLength(1);
      expect(data.conflicts[0]!.severity).toBe("warning");
    });
  });

  describe("scan_event_proposal", () => {
    it("compares a proposal against the feed and flags overlaps", async () => {
      setConflictDetectLoader({ loadFeed: async () => FEED_WITH_OVERLAP });
      const result = await callConflict(makeRuntime(), makeMessage(), {
        subaction: "scan_event_proposal",
        proposal: {
          startISO: "2026-05-11T09:15:00.000Z",
          endISO: "2026-05-11T09:45:00.000Z",
          attendees: ["alice@example.com"],
        },
      });
      expect(result.success).toBe(true);
      const data = result.data as {
        conflicts: { eventA: { id: string }; eventB: { id: string } }[];
      };
      expect(data.conflicts.length).toBeGreaterThan(0);
      expect(data.conflicts.every((c) => c.eventA.id === "proposal")).toBe(
        true,
      );
    });

    it("errors when proposal is missing", async () => {
      const result = await callConflict(makeRuntime(), makeMessage(), {
        subaction: "scan_event_proposal",
      });
      expect(result.success).toBe(false);
      expect(result.data).toMatchObject({ error: "MISSING_PROPOSAL" });
    });

    it("returns no conflicts when the proposal does not overlap anything", async () => {
      setConflictDetectLoader({ loadFeed: async () => FEED_WITH_OVERLAP });
      const result = await callConflict(makeRuntime(), makeMessage(), {
        subaction: "scan_event_proposal",
        proposal: {
          startISO: "2026-05-11T22:00:00.000Z",
          endISO: "2026-05-11T22:30:00.000Z",
        },
      });
      expect(result.success).toBe(true);
      const data = result.data as { conflicts: unknown[] };
      expect(data.conflicts).toHaveLength(0);
    });
  });
});
