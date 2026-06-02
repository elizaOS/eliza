import type { Component, Entity, IAgentRuntime, UUID } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { getExpiringSessions, getStaleSessions } from "./storage";
import type { FormSession } from "./types";
import { FORM_SESSION_COMPONENT } from "./types";

const agentId = "00000000-0000-4000-8000-000000000201" as UUID;
const entityId = "00000000-0000-4000-8000-000000000202" as UUID;
const roomId = "00000000-0000-4000-8000-000000000203" as UUID;

function makeSession(overrides: Partial<FormSession> = {}): FormSession {
  const now = Date.now();
  return {
    id: "session-1",
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
      firstInteractionAt: now - 10_000,
      lastInteractionAt: now - 10_000,
    },
    expiresAt: now + 86_400_000,
    createdAt: now - 10_000,
    updatedAt: now - 10_000,
    ...overrides,
  };
}

function makeComponent(session: FormSession): Component {
  return {
    id: `${session.id}-component` as UUID,
    entityId: session.entityId,
    agentId,
    roomId: session.roomId,
    worldId: agentId,
    sourceEntityId: agentId,
    type: `${FORM_SESSION_COMPONENT}:${session.roomId}`,
    createdAt: session.createdAt,
    data: session,
  } as Component;
}

function makeRuntime(components: Component[]): IAgentRuntime {
  return {
    agentId,
    queryEntities: vi.fn(
      async (params: { componentDataFilter?: { status?: string } }) => {
        const status = params.componentDataFilter?.status;
        const matched = components.filter((component) => {
          const data = component.data as { status?: string } | undefined;
          return !status || data?.status === status;
        });
        const byEntity = new Map<UUID, Component[]>();
        for (const component of matched) {
          byEntity.set(component.entityId, [
            ...(byEntity.get(component.entityId) ?? []),
            ...components.filter(
              (candidate) => candidate.entityId === component.entityId,
            ),
          ]);
        }
        return [...byEntity].map(
          ([id, entityComponents]) =>
            ({
              id,
              agentId,
              names: ["Test Entity"],
              components: entityComponents,
            }) as Entity,
        );
      },
    ),
  } as unknown as IAgentRuntime;
}

describe("form storage session scans", () => {
  it("returns stale live sessions and ignores unrelated or fresh components", async () => {
    const now = Date.now();
    const stale = makeSession({
      id: "stale",
      effort: {
        interactionCount: 2,
        timeSpentMs: 2000,
        firstInteractionAt: now - 100_000,
        lastInteractionAt: now - 90_000,
      },
    });
    const fresh = makeSession({
      id: "fresh",
      effort: {
        interactionCount: 1,
        timeSpentMs: 1000,
        firstInteractionAt: now - 10_000,
        lastInteractionAt: now - 5_000,
      },
    });
    const unrelated = {
      ...makeComponent(makeSession({ id: "unrelated" })),
      type: "other_component",
    };

    const sessions = await getStaleSessions(
      makeRuntime([makeComponent(stale), makeComponent(fresh), unrelated]),
      60_000,
    );

    expect(sessions.map((session) => session.id)).toEqual(["stale"]);
  });

  it("returns live sessions expiring within the requested window", async () => {
    const now = Date.now();
    const expiring = makeSession({
      id: "expiring",
      status: "ready",
      expiresAt: now + 30_000,
    });
    const later = makeSession({
      id: "later",
      status: "stashed",
      expiresAt: now + 120_000,
    });
    const expired = makeSession({
      id: "expired",
      expiresAt: now - 1,
    });

    const sessions = await getExpiringSessions(
      makeRuntime([
        makeComponent(expiring),
        makeComponent(later),
        makeComponent(expired),
      ]),
      60_000,
    );

    expect(sessions.map((session) => session.id)).toEqual(["expiring"]);
  });
});
