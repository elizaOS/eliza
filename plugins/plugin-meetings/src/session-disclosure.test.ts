import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  __disclosureCalls,
  __resetCalls,
  __resetDisclosure,
  __resetGrants,
  __setDisclosure,
  __setGrants,
} from "./core_mock.mjs";
import { selectSessionForViewer } from "./session-disclosure.ts";

function makeRuntime(agentId = "agent-1") {
  const memoryById = vi.fn();
  return {
    agentId,
    getMemoryById: memoryById,
    __memoryById: memoryById,
  };
}

function makeSession(overrides = {}) {
  return {
    id: "session-1",
    roomId: "room-1",
    transcriptId: "transcript-1",
    ...overrides,
  };
}

function makeRow(overrides = {}) {
  return {
    id: "transcript-1",
    entityId: "entity-owner",
    content: { transcript: JSON.stringify({ scope: "public" }) },
    metadata: {},
    ...overrides,
  };
}

const accessContext = { viewerId: "viewer-1" };

describe("selectSessionForViewer", () => {
  beforeEach(() => {
    __resetDisclosure();
    __resetGrants();
    __resetCalls();
  });

  it("fails CLOSED to owner-private when the stored transcript JSON is unparseable", async () => {
    const runtime = makeRuntime();
    runtime.__memoryById.mockResolvedValue(
      makeRow({ content: { transcript: "{not-json" } }),
    );
    await selectSessionForViewer(runtime, accessContext, makeSession());
    const calls = __disclosureCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0].args.scope).toBe("owner-private");
  });

  it("fails CLOSED to owner-private when transcript is not a string (malformed row)", async () => {
    const runtime = makeRuntime();
    runtime.__memoryById.mockResolvedValue(
      makeRow({ content: { transcript: { scope: "public" } } }),
    );
    await selectSessionForViewer(runtime, accessContext, makeSession());
    const calls = __disclosureCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0].args.scope).toBe("owner-private");
  });

  it("passes the normalized scope from a well-formed transcript row", async () => {
    const runtime = makeRuntime();
    runtime.__memoryById.mockResolvedValue(makeRow());
    await selectSessionForViewer(runtime, accessContext, makeSession());
    const calls = __disclosureCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0].args.scope).toBe("public");
  });

  it("falls back to the row entityId when scopedToEntityId is not a string", async () => {
    const runtime = makeRuntime();
    runtime.__memoryById.mockResolvedValue(
      makeRow({ metadata: { scopedToEntityId: 42 } }),
    );
    await selectSessionForViewer(runtime, accessContext, makeSession());
    const calls = __disclosureCalls();
    expect(calls[0].args.scopedEntityId).toBe("entity-owner");
  });

  it("prefers the metadata scopedToEntityId when it is a string", async () => {
    const runtime = makeRuntime();
    runtime.__memoryById.mockResolvedValue(
      makeRow({ metadata: { scopedToEntityId: "scoped-entity-9" } }),
    );
    await selectSessionForViewer(runtime, accessContext, makeSession());
    const calls = __disclosureCalls();
    expect(calls[0].args.scopedEntityId).toBe("scoped-entity-9");
  });

  it("withholds transcriptId when the transcript row is missing (dangling id)", async () => {
    const runtime = makeRuntime();
    runtime.__memoryById.mockResolvedValue(undefined);
    const session = makeSession();
    const result = await selectSessionForViewer(
      runtime,
      accessContext,
      session,
    );
    expect(result.transcriptId).toBeUndefined();
    expect(result.id).toBe("session-1");
    expect(result.roomId).toBe("room-1");
  });

  it("serves the session unchanged when there is no access context", async () => {
    const runtime = makeRuntime();
    const session = makeSession();
    const result = await selectSessionForViewer(runtime, undefined, session);
    expect(result).toEqual(session);
    expect(runtime.__memoryById).not.toHaveBeenCalled();
  });

  it("serves the session unchanged when it has no transcriptId", async () => {
    const runtime = makeRuntime();
    const session = makeSession({ transcriptId: undefined });
    const result = await selectSessionForViewer(
      runtime,
      accessContext,
      session,
    );
    expect(result).toEqual(session);
    expect(runtime.__memoryById).not.toHaveBeenCalled();
  });

  it("keeps the session as stored when disclosure resolves to full", async () => {
    const runtime = makeRuntime();
    runtime.__memoryById.mockResolvedValue(makeRow());
    __setDisclosure("full");
    const session = makeSession();
    const result = await selectSessionForViewer(
      runtime,
      accessContext,
      session,
    );
    expect(result).toEqual(session);
    expect(result.transcriptRedacted).toBeUndefined();
  });

  it("flags transcriptRedacted and keeps the navigable id on redacted disclosure", async () => {
    const runtime = makeRuntime();
    runtime.__memoryById.mockResolvedValue(makeRow());
    __setDisclosure("redacted");
    const result = await selectSessionForViewer(
      runtime,
      accessContext,
      makeSession(),
    );
    expect(result.transcriptRedacted).toBe(true);
    expect(result.transcriptId).toBe("transcript-1");
  });

  it("withholds transcriptId on no-disclosure while keeping roster fields", async () => {
    const runtime = makeRuntime();
    runtime.__memoryById.mockResolvedValue(makeRow());
    __setDisclosure("none");
    const session = makeSession({ roomId: "room-1", id: "session-1" });
    const result = await selectSessionForViewer(
      runtime,
      accessContext,
      session,
    );
    expect(result.transcriptId).toBeUndefined();
    expect(result.id).toBe("session-1");
    expect(result.roomId).toBe("room-1");
  });
});
