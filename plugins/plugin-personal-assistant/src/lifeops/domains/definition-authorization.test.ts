import { describe, expect, it, vi } from "vitest";
import {
  callerDefinitionScopes,
  getCallerDefinition,
  getCallerOccurrence,
  getCallerOccurrenceView,
  listCallerDefinitions,
  nextMutationRevision,
} from "./definition-authorization.js";

const ctx = () => ({
  agentId: () => "agent-1",
  ownerEntityId: () => "owner-9",
});

function repo() {
  return {
    getDefinition: vi.fn(async () => null),
    getOccurrence: vi.fn(async () => null),
    getOccurrenceView: vi.fn(async () => null),
    listDefinitions: vi.fn(async () => []),
    listActiveDefinitions: vi.fn(async () => []),
  };
}

describe("callerDefinitionScopes", () => {
  it("exposes exactly the agent and owner scopes for the caller", () => {
    expect(callerDefinitionScopes(ctx())).toEqual([
      { domain: "agent_ops", subjectType: "agent", subjectId: "agent-1" },
      {
        domain: "user_lifeops",
        subjectType: "owner",
        subjectId: "owner-9",
      },
    ]);
  });
});

describe("getCallerDefinition", () => {
  it("searches both scopes and returns the first hit", async () => {
    const r = repo();
    const definition = { id: "d1", createdAt: "2026-08-01T00:00:00.000Z" };
    r.getDefinition
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(definition);
    await expect(getCallerDefinition(r as never, ctx(), "d1")).resolves.toBe(
      definition,
    );
    expect(r.getDefinition).toHaveBeenCalledTimes(2);
    expect(r.getDefinition).toHaveBeenNthCalledWith(1, "agent-1", "d1", {
      domain: "agent_ops",
      subjectType: "agent",
      subjectId: "agent-1",
    });
  });

  it("returns null when no scope has the definition", async () => {
    const r = repo();
    await expect(
      getCallerDefinition(r as never, ctx(), "missing"),
    ).resolves.toBeNull();
    expect(r.getDefinition).toHaveBeenCalledTimes(2);
  });
});

describe("getCallerOccurrence / getCallerOccurrenceView", () => {
  it("returns the first matching occurrence across scopes", async () => {
    const r = repo();
    const occurrence = { id: "o1" };
    r.getOccurrence.mockResolvedValueOnce(occurrence);
    await expect(getCallerOccurrence(r as never, ctx(), "o1")).resolves.toBe(
      occurrence,
    );
    expect(r.getOccurrence).toHaveBeenCalledTimes(1);
  });

  it("returns the first matching occurrence view across scopes", async () => {
    const r = repo();
    const view = { id: "v1" };
    r.getOccurrenceView.mockResolvedValueOnce(null).mockResolvedValueOnce(view);
    await expect(
      getCallerOccurrenceView(r as never, ctx(), "v1"),
    ).resolves.toBe(view);
    expect(r.getOccurrenceView).toHaveBeenCalledTimes(2);
  });
});

describe("listCallerDefinitions", () => {
  it("flattens and sorts both scopes by createdAt then id", async () => {
    const r = repo();
    r.listDefinitions.mockResolvedValueOnce([
      { id: "b", createdAt: "2026-08-02T00:00:00.000Z" },
    ]);
    r.listDefinitions.mockResolvedValueOnce([
      { id: "a", createdAt: "2026-08-01T00:00:00.000Z" },
      { id: "c", createdAt: "2026-08-01T00:00:00.000Z" },
    ]);
    const result = await listCallerDefinitions(r as never, ctx());
    expect(result.map((d) => d.id)).toEqual(["a", "c", "b"]);
    expect(r.listDefinitions).toHaveBeenCalledTimes(2);
  });

  it("dispatches to listActiveDefinitions when activeOnly is set", async () => {
    const r = repo();
    await listCallerDefinitions(r as never, ctx(), { activeOnly: true });
    expect(r.listActiveDefinitions).toHaveBeenCalledTimes(2);
    expect(r.listDefinitions).not.toHaveBeenCalled();
  });
});

describe("nextMutationRevision", () => {
  const candidate = new Date("2026-08-10T12:00:00.000Z");

  it("returns the candidate when it is strictly newer than the predecessor", () => {
    expect(nextMutationRevision("2026-08-01T00:00:00.000Z", candidate)).toBe(
      "2026-08-10T12:00:00.000Z",
    );
  });

  it("returns predecessor + 1ms when the candidate is older", () => {
    expect(nextMutationRevision("2026-08-10T12:00:05.000Z", candidate)).toBe(
      "2026-08-10T12:00:05.001Z",
    );
  });

  it("returns predecessor + 1ms when the candidate equals the predecessor", () => {
    expect(nextMutationRevision("2026-08-10T12:00:00.000Z", candidate)).toBe(
      "2026-08-10T12:00:00.001Z",
    );
  });

  it("documents the crash on an unparseable persisted timestamp", () => {
    // Degenerate case, pinned as current behavior: Date.parse of a garbage
    // timestamp is NaN, Math.max(NaN, ...) is NaN, and new Date(NaN)
    // .toISOString() throws RangeError ("Invalid time value"). A corrupt
    // persisted row therefore crashes the mutation path instead of producing
    // a revision; a follow-up fix should fall back to the candidate clock.
    expect(() => nextMutationRevision("not-a-date", candidate)).toThrow(
      RangeError,
    );
    expect(() => nextMutationRevision("", candidate)).toThrow(RangeError);
  });
});
