/**
 * Form progress is the share of required fields that are filled.
 * Optional answers must not move that percentage.
 */
import type { Component, IAgentRuntime, UUID } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FormService } from "./service";
import type { FormDefinition } from "./types";

const entityId = "00000000-0000-4000-8000-000000000901" as UUID;
const roomId = "00000000-0000-4000-8000-000000000902" as UUID;
const agentId = "00000000-0000-4000-8000-000000000903" as UUID;

function makeRuntime() {
  const components = new Map<string, Component>();
  const keyFor = (entity: UUID, type: string) => `${entity}:${type}`;
  return {
    agentId,
    getRoom: vi.fn(async () => ({ id: roomId, worldId: agentId })),
    getComponent: vi.fn(async (entity: UUID, type: string) =>
      components.get(keyFor(entity, type)),
    ),
    getComponents: vi.fn(async (entity: UUID) =>
      Array.from(components.values()).filter((c) => c.entityId === entity),
    ),
    createComponent: vi.fn(async (component: Component) => {
      components.set(keyFor(component.entityId, component.type), component);
    }),
    updateComponent: vi.fn(async (component: Component) => {
      components.set(keyFor(component.entityId, component.type), component);
    }),
    deleteComponent: vi.fn(async () => undefined),
    emitEvent: vi.fn(async () => undefined),
    registerTaskWorker: vi.fn(),
    logger: {
      debug: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
    },
  } as unknown as IAgentRuntime;
}

function signupForm(): FormDefinition {
  return {
    id: "signup",
    name: "Signup",
    controls: [
      { key: "name", label: "Name", type: "text", required: true },
      { key: "note", label: "Note", type: "text", required: false },
    ],
  };
}

describe("FormService required-field progress", () => {
  let service: FormService;

  beforeEach(async () => {
    service = (await FormService.start(makeRuntime())) as FormService;
    service.registerForm(signupForm());
  });

  it("stays at 0 when only an optional field is filled", async () => {
    const session = await service.startSession("signup", entityId, roomId, {
      initialValues: { note: "later" },
    });
    expect(service.getSessionContext(session).progress).toBe(0);
  });

  it("stays at 100 when the required field and an optional field are filled", async () => {
    const session = await service.startSession("signup", entityId, roomId, {
      initialValues: { name: "Jane", note: "later" },
    });
    expect(service.getSessionContext(session).progress).toBe(100);
  });
});
