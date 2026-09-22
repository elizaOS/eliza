/** Exercises contact batching at the real FOLLOW_UPS provider boundary. */
import type { IAgentRuntime, Memory, State, UUID } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { followUpsProvider } from "./followUps.js";

const message = { roomId: "room-1" as UUID } as Memory;
const state = {} as State;
const followUp = (id: string, entityId: string) => ({
  task: { id: id as UUID, metadata: { reason: id } },
  contact: { entityId: entityId as UUID },
});

function harness(items: ReturnType<typeof followUp>[]) {
  const service = {
    getUpcomingFollowUps: vi.fn().mockResolvedValue(items),
    getFollowUpSuggestions: vi.fn().mockResolvedValue([]),
  };
  const getEntitiesByIds = vi.fn().mockResolvedValue([]);
  const getEntityById = vi.fn(() => {
    throw new Error("Unexpected single-entity read");
  });
  const reportError = vi.fn();
  const runtime = {
    getService: vi.fn().mockReturnValue(service),
    getEntitiesByIds,
    getEntityById,
    reportError,
    logger: { warn: vi.fn(), error: vi.fn() },
  } as unknown as IAgentRuntime;
  return { runtime, service, getEntitiesByIds, getEntityById, reportError };
}

describe("followUpsProvider", () => {
  it("reads contacts once and preserves every label when batch rows arrive out of order", async () => {
    const items = Array.from({ length: 64 }, (_, i) =>
      followUp(`reason-${i}`, `entity-${i}`),
    );
    const h = harness(items);
    h.getEntitiesByIds.mockResolvedValue(
      items.toReversed().map(({ contact }) => ({
        id: contact.entityId,
        names: [`Name ${contact.entityId}`],
      })),
    );
    const result = await followUpsProvider.get(h.runtime, message, state);
    expect(h.getEntitiesByIds).toHaveBeenCalledExactlyOnceWith(
      items.map(({ contact }) => contact.entityId),
    );
    expect(h.getEntityById).not.toHaveBeenCalled();
    expect(result.values?.followUpCount).toBe(items.length);
    expect(
      result.text?.split("\n").filter((line) => line.startsWith("- ")),
    ).toEqual(
      items.map(
        ({ task, contact }) =>
          `- Name ${contact.entityId} - ${task.metadata.reason}`,
      ),
    );
  });

  it("preserves repeated contacts and labels missing or unnamed entities without shifting names", async () => {
    const h = harness([
      followUp("first", "e1"),
      followUp("missing", "e2"),
      followUp("again", "e1"),
      followUp("unnamed", "e3"),
      followUp("last", "e4"),
    ]);
    h.getEntitiesByIds.mockResolvedValue([
      { id: "e4", names: ["Dana"] },
      { id: "e3", names: [] },
      { id: "e1", names: ["Alice"] },
    ]);
    const result = await followUpsProvider.get(h.runtime, message, state);
    expect(h.getEntitiesByIds).toHaveBeenCalledExactlyOnceWith([
      "e1",
      "e2",
      "e3",
      "e4",
    ]);
    expect(
      result.text?.split("\n").filter((line) => line.startsWith("- ")),
    ).toEqual([
      "- Alice - first",
      "- Unknown - missing",
      "- Alice - again",
      "- Unknown - unnamed",
      "- Dana - last",
    ]);
    expect(result.values?.followUpCount).toBe(5);
  });

  it("does not query contacts for an empty follow-up list", async () => {
    const h = harness([]);
    const result = await followUpsProvider.get(h.runtime, message, state);
    expect(h.getEntitiesByIds).not.toHaveBeenCalled();
    expect(h.getEntityById).not.toHaveBeenCalled();
    expect(result.values?.followUpCount).toBe(0);
  });

  it("reports a failed batch as unavailable instead of fabricating an empty list", async () => {
    const h = harness([followUp("first", "e1")]);
    const error = new Error("Database unavailable");
    h.getEntitiesByIds.mockRejectedValue(error);
    const result = await followUpsProvider.get(h.runtime, message, state);
    expect(h.getEntitiesByIds).toHaveBeenCalledExactlyOnceWith(["e1"]);
    expect(h.reportError).toHaveBeenCalledWith("FollowUpsProvider.get", error, {
      roomId: message.roomId,
    });
    expect(result.values?.followUpsAvailable).toBe(false);
    expect(result.values?.followUpCount).toBeUndefined();
    expect(h.service.getFollowUpSuggestions).not.toHaveBeenCalled();
  });
});
