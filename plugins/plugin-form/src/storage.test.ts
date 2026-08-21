/**
 * Exercises form component persistence and bounded snapshot construction.
 * The deterministic runtime covers real storage and FormService entry points
 * without external services.
 */
import type {
  Component,
  Entity,
  IAgentRuntime,
  JsonValue,
  UUID,
} from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FormService } from "./service";
import {
  FORM_COMPONENT_DATA_UNBOUNDED,
  getExpiringSessions,
  getStaleSessions,
  MAX_FORM_COMPONENT_DATA_BYTES,
  MAX_FORM_COMPONENT_DATA_DEPTH,
  MAX_FORM_COMPONENT_DATA_NODES,
  saveAutofillData,
  saveSession,
  saveSubmission,
  toComponentData,
} from "./storage";
import {
  FORM_SESSION_COMPONENT,
  type FormSession,
  type FormSubmission,
} from "./types";

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

describe("bounded form component data", () => {
  it("serializes normal plain objects cleanly", () => {
    const data = { id: "123", name: "test", count: 42, active: true };
    expect(toComponentData(data)).toEqual(data);
  });

  it("duplicates honest shared references without treating them as cycles", () => {
    const shared = { answer: 42 };
    expect(toComponentData({ first: shared, second: shared })).toEqual({
      first: { answer: 42 },
      second: { answer: 42 },
    });
  });

  it("rejects circular structures with a typed failure", () => {
    const circular: Record<string, unknown> = {
      id: "123",
      title: "form",
    };
    circular.self = circular;

    expect(() => toComponentData(circular)).toThrow(
      expect.objectContaining({ code: FORM_COMPONENT_DATA_UNBOUNDED }),
    );
  });

  it("rejects accessors without invoking them", () => {
    const getter = vi.fn(() => "secret");
    const value = { id: "valid" } as Record<string, unknown>;
    Object.defineProperty(value, "secret", { enumerable: true, get: getter });

    expect(() => toComponentData(value)).toThrow(
      expect.objectContaining({ code: FORM_COMPONENT_DATA_UNBOUNDED }),
    );
    expect(getter).not.toHaveBeenCalled();
  });

  it("wraps revoked proxy reflection failures with their cause", () => {
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    let failure: unknown;
    try {
      toComponentData(proxy);
    } catch (error) {
      failure = error;
    }
    expect(failure).toEqual(
      expect.objectContaining({ code: FORM_COMPONENT_DATA_UNBOUNDED }),
    );
    expect((failure as Error).cause).toBeInstanceOf(TypeError);
  });

  it("accepts the exact depth limit and rejects the next level", () => {
    const nested = (depth: number): Record<string, unknown> => {
      let value: Record<string, unknown> = {};
      for (let index = 0; index < depth; index += 1) value = { child: value };
      return value;
    };
    expect(() =>
      toComponentData(nested(MAX_FORM_COMPONENT_DATA_DEPTH)),
    ).not.toThrow();
    expect(() =>
      toComponentData(nested(MAX_FORM_COMPONENT_DATA_DEPTH + 1)),
    ).toThrow(expect.objectContaining({ code: FORM_COMPONENT_DATA_UNBOUNDED }));
  });

  it("accounts for sparse array slots at the exact node limit", () => {
    expect(() =>
      toComponentData({ values: new Array(MAX_FORM_COMPONENT_DATA_NODES - 2) }),
    ).not.toThrow();
    expect(() =>
      toComponentData({ values: new Array(MAX_FORM_COMPONENT_DATA_NODES - 1) }),
    ).toThrow(expect.objectContaining({ code: FORM_COMPONENT_DATA_UNBOUNDED }));
  });

  it("enforces the UTF-8 byte limit at exact and max-plus-one", () => {
    const structuralBytes = 14;
    const exact = "é".repeat(
      (MAX_FORM_COMPONENT_DATA_BYTES - structuralBytes) / 2,
    );
    expect(() => toComponentData({ payload: exact })).not.toThrow();
    expect(() => toComponentData({ payload: `${exact}é` })).toThrow(
      expect.objectContaining({ code: FORM_COMPONENT_DATA_UNBOUNDED }),
    );
  });

  it("preserves an own __proto__ key without mutating the result prototype", () => {
    const value: Record<string, unknown> = {};
    Object.defineProperty(value, "__proto__", {
      enumerable: true,
      value: { polluted: true },
    });
    const data = toComponentData(value);
    expect(Object.getPrototypeOf(data)).toBeNull();
    expect(Object.hasOwn(data, "__proto__")).toBe(true);
    expect(Object.getOwnPropertyDescriptor(data, "__proto__")?.value).toEqual({
      polluted: true,
    });
  });
});

function makePersistenceRuntime() {
  return {
    agentId,
    createComponent: vi.fn(async () => undefined),
    updateComponent: vi.fn(async () => undefined),
    deleteComponent: vi.fn(async () => undefined),
    getComponent: vi.fn(async () => null),
    getRoom: vi.fn(async () => ({ id: roomId, worldId: agentId })),
  };
}

function expectNoPersistence(
  runtime: ReturnType<typeof makePersistenceRuntime>,
) {
  expect(runtime.getComponent).not.toHaveBeenCalled();
  expect(runtime.getRoom).not.toHaveBeenCalled();
  expect(runtime.createComponent).not.toHaveBeenCalled();
  expect(runtime.updateComponent).not.toHaveBeenCalled();
  expect(runtime.deleteComponent).not.toHaveBeenCalled();
}

describe("form persistence staging", () => {
  it("rejects a circular session before any runtime call", async () => {
    const runtime = makePersistenceRuntime();

    const session = makeSession("cyclic-session");
    (session.fields as Record<string, unknown>).cycle = session;

    await expect(
      saveSession(runtime as unknown as IAgentRuntime, session),
    ).rejects.toMatchObject({ code: FORM_COMPONENT_DATA_UNBOUNDED });
    expectNoPersistence(runtime);
  });

  it("rejects a circular submission before any runtime call", async () => {
    const runtime = makePersistenceRuntime();

    const submission: FormSubmission = {
      id: "sub-1",
      formId: "feedback",
      formVersion: 1,
      sessionId: "session-1",
      entityId,
      submittedAt: NOW,
      values: { comments: "great" },
    };
    (submission.values as Record<string, unknown>).cycle = submission;

    await expect(
      saveSubmission(runtime as unknown as IAgentRuntime, submission),
    ).rejects.toMatchObject({ code: FORM_COMPONENT_DATA_UNBOUNDED });
    expectNoPersistence(runtime);
  });

  it("rejects circular autofill values before any runtime call", async () => {
    const runtime = makePersistenceRuntime();

    const values: Record<string, JsonValue> = { name: "Alice" };
    (values as Record<string, unknown>).cycle = values;

    await expect(
      saveAutofillData(
        runtime as unknown as IAgentRuntime,
        entityId,
        "feedback",
        values,
      ),
    ).rejects.toMatchObject({ code: FORM_COMPONENT_DATA_UNBOUNDED });
    expectNoPersistence(runtime);
  });

  it("rejects an accessor through the real FormService without dispatch", async () => {
    const runtime = makePersistenceRuntime();
    const service = (await FormService.start(
      runtime as unknown as IAgentRuntime,
    )) as FormService;
    const session = makeSession("service-session") as FormSession &
      Record<string, unknown>;
    const getter = vi.fn(() => "secret");
    Object.defineProperty(session, "secret", { enumerable: true, get: getter });

    await expect(service.saveSession(session)).rejects.toMatchObject({
      code: FORM_COMPONENT_DATA_UNBOUNDED,
    });
    expect(getter).not.toHaveBeenCalled();
    expectNoPersistence(runtime);
  });
});
