/**
 * Regression tests for session component keying (issue #22272). Sessions must be
 * keyed by (roomId, sessionId) so a stashed session survives a new session
 * started in the same room. Runs against an in-memory component store that
 * mirrors the runtime's natural-key getComponent(entityId, type) semantics
 * (see packages/core/src/runtime.ts getComponent -> getComponentsByNaturalKeys).
 * Deterministic, no live model.
 */
import type { Component, IAgentRuntime, UUID } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  deleteSession,
  getActiveSession,
  getSessionById,
  getStashedSessions,
  saveSession,
} from "./storage";
import type { FormSession } from "./types";

const agentId = "00000000-0000-4000-8000-000000000301" as UUID;
const entityId = "00000000-0000-4000-8000-000000000302" as UUID;
const roomId = "00000000-0000-4000-8000-000000000303" as UUID;
const otherRoomId = "00000000-0000-4000-8000-000000000304" as UUID;
// Base timestamps on the real clock so isExpired()/isLiveSession() treat every
// fixture session as live regardless of when the suite runs.
const NOW = Date.now();

function makeSession(
  id: string,
  overrides: Partial<FormSession> = {},
): FormSession {
  return {
    id,
    formId: "signup",
    formVersion: 1,
    entityId,
    roomId,
    status: "active",
    fields: {},
    history: [],
    effort: {
      interactionCount: 1,
      timeSpentMs: 1000,
      firstInteractionAt: NOW - 10_000,
      lastInteractionAt: NOW - 10_000,
    },
    // Well in the future so isLiveSession() is always true.
    expiresAt: NOW + 86_400_000_000,
    createdAt: NOW - 10_000,
    updatedAt: NOW - 10_000,
    ...overrides,
  };
}

/**
 * In-memory component store keyed exactly like the runtime: by the natural key
 * (entityId, type). This is the semantics that made the room-only key destroy
 * stashed sessions.
 */
function makeRuntime(): IAgentRuntime {
  const components = new Map<string, Component>();
  const keyFor = (entity: UUID, type: string) => `${entity}:${type}`;

  return {
    agentId,
    getRoom: async () => ({ id: roomId, worldId: agentId }),
    getComponent: async (entity: UUID, type: string) =>
      components.get(keyFor(entity, type)),
    getComponents: async (entity: UUID) =>
      Array.from(components.values()).filter((c) => c.entityId === entity),
    createComponent: async (component: Component) => {
      components.set(keyFor(component.entityId, component.type), component);
      return true;
    },
    updateComponent: async (component: Component) => {
      components.set(keyFor(component.entityId, component.type), component);
    },
    deleteComponent: async (id: UUID) => {
      for (const [key, component] of components) {
        if (component.id === id) components.delete(key);
      }
    },
  } as unknown as IAgentRuntime;
}

describe("form session component keying (issue #22272)", () => {
  it("keeps a stashed session when a new session starts in the same room", async () => {
    const runtime = makeRuntime();

    await saveSession(runtime, makeSession("sessionA", { status: "stashed" }));
    expect(
      (await getStashedSessions(runtime, entityId)).map((s) => s.id),
    ).toEqual(["sessionA"]);

    // Starting a new active session in the SAME room previously overwrote the
    // stashed component because both mapped to type form_session:{roomId}.
    await saveSession(runtime, makeSession("sessionB", { status: "active" }));

    const stashed = await getStashedSessions(runtime, entityId);
    expect(stashed.map((s) => s.id)).toEqual(["sessionA"]);

    const active = await getActiveSession(runtime, entityId, roomId);
    expect(active?.id).toBe("sessionB");

    // The stashed session is still individually retrievable by id.
    expect((await getSessionById(runtime, entityId, "sessionA"))?.id).toBe(
      "sessionA",
    );
  });

  it("persists two stashed sessions in one room and lists both", async () => {
    const runtime = makeRuntime();

    await saveSession(runtime, makeSession("stashA", { status: "stashed" }));
    await saveSession(runtime, makeSession("stashB", { status: "stashed" }));

    const stashedIds = (await getStashedSessions(runtime, entityId))
      .map((s) => s.id)
      .sort();
    expect(stashedIds).toEqual(["stashA", "stashB"]);
  });

  it("deletes only the targeted session and leaves siblings intact", async () => {
    const runtime = makeRuntime();

    const stashed = makeSession("stashA", { status: "stashed" });
    const active = makeSession("activeB", { status: "active" });
    await saveSession(runtime, stashed);
    await saveSession(runtime, active);

    await deleteSession(runtime, active);

    expect(await getSessionById(runtime, entityId, "activeB")).toBeNull();
    expect((await getSessionById(runtime, entityId, "stashA"))?.id).toBe(
      "stashA",
    );
    expect(await getActiveSession(runtime, entityId, roomId)).toBeNull();
  });

  it("scopes active-session lookup to the requested room", async () => {
    const runtime = makeRuntime();

    await saveSession(
      runtime,
      makeSession("here", { status: "active", roomId }),
    );
    await saveSession(
      runtime,
      makeSession("there", { status: "active", roomId: otherRoomId }),
    );

    expect((await getActiveSession(runtime, entityId, roomId))?.id).toBe(
      "here",
    );
    expect((await getActiveSession(runtime, entityId, otherRoomId))?.id).toBe(
      "there",
    );
  });

  it("updates a session in place without creating a duplicate component", async () => {
    const runtime = makeRuntime();

    const session = makeSession("sessionA", { status: "active" });
    await saveSession(runtime, session);
    await saveSession(runtime, { ...session, status: "stashed" });

    const all = await getSessionById(runtime, entityId, "sessionA");
    expect(all?.status).toBe("stashed");
    // Exactly one active-or-stashed component should exist for this session.
    const components = await runtime.getComponents(entityId);
    const sessionComponents = components.filter((c) =>
      c.type.includes("sessionA"),
    );
    expect(sessionComponents).toHaveLength(1);
  });
});
