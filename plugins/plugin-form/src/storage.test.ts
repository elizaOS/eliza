/**
 * Tests the form-storage session scans: locating stale live form sessions and
 * those expiring within a requested window, ignoring unrelated components. Runs
 * against a stub component store, no live model.
 */
import type {
  Component,
  Entity,
  IAgentRuntime,
  JsonValue,
  UUID,
} from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getExpiringSessions, getStaleSessions } from "./storage";
import { FORM_SESSION_COMPONENT, type FormSession } from "./types";

const NOW = 1_700_000_000_000;
const agentId = "00000000-0000-4000-8000-000000000201" as UUID;
const entityId = "00000000-0000-4000-8000-000000000202" as UUID;
const roomId = "00000000-0000-4000-8000-000000000203" as UUID;

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
    expiresAt: NOW + 86_400_000,
    createdAt: NOW - 10_000,
    updatedAt: NOW - 10_000,
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
    data: session as unknown as Record<string, JsonValue>,
  };
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

afterEach(() => {
  vi.useRealTimers();
});

describe("form storage session scans", () => {
  it("returns stale live sessions and ignores unrelated or fresh components", async () => {
    vi.setSystemTime(NOW);
    const stale = makeSession("stale", {
      effort: {
        interactionCount: 2,
        timeSpentMs: 2000,
        firstInteractionAt: NOW - 100_000,
        lastInteractionAt: NOW - 90_000,
      },
    });
    const fresh = makeSession("fresh", {
      effort: {
        interactionCount: 1,
        timeSpentMs: 1000,
        firstInteractionAt: NOW - 10_000,
        lastInteractionAt: NOW - 5_000,
      },
    });
    const stashed = makeSession("stashed", {
      status: "stashed",
      effort: {
        interactionCount: 1,
        timeSpentMs: 1000,
        firstInteractionAt: NOW - 100_000,
        lastInteractionAt: NOW - 90_000,
      },
    });
    const unrelated = {
      ...makeComponent(makeSession("unrelated")),
      type: "other_component",
    };

    const sessions = await getStaleSessions(
      makeRuntime([
        makeComponent(stale),
        makeComponent(fresh),
        makeComponent(stashed),
        unrelated,
      ]),
      60_000,
    );

    expect(sessions.map((session) => session.id)).toEqual(["stale", "stashed"]);
  });

  it("returns live sessions expiring within the requested window", async () => {
    vi.setSystemTime(NOW);
    const expiring = makeSession("expiring", {
      status: "ready",
      expiresAt: NOW + 30_000,
    });
    const stashed = makeSession("stashed", {
      status: "stashed",
      expiresAt: NOW + 45_000,
    });
    const later = makeSession("later", {
      expiresAt: NOW + 120_000,
    });
    const expired = makeSession("expired", {
      expiresAt: NOW - 1,
    });

    const sessions = await getExpiringSessions(
      makeRuntime([
        makeComponent(expiring),
        makeComponent(stashed),
        makeComponent(later),
        makeComponent(expired),
      ]),
      60_000,
    );

    expect(sessions.map((session) => session.id)).toEqual([
      "expiring",
      "stashed",
    ]);
  });
});
