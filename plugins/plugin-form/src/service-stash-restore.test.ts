/**
 * Regression test for FormService stash/restore across a same-room restart
 * (issue #22272). Exercises the real FormService against an in-memory component
 * store that mirrors the runtime's natural-key (entityId, type) semantics, so
 * the stash -> start-new-form -> restore path is proven end to end. Deterministic,
 * no live model.
 */
import type { Component, IAgentRuntime, UUID } from "@elizaos/core";
import { beforeEach, describe, expect, it } from "vitest";
import { FormService } from "./service";
import type { FormDefinition } from "./types";

const entityId = "00000000-0000-4000-8000-000000000401" as UUID;
const roomId = "00000000-0000-4000-8000-000000000402" as UUID;
const agentId = "00000000-0000-4000-8000-000000000403" as UUID;

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
    emitEvent: async () => undefined,
    registerTaskWorker: () => undefined,
    getTaskWorker: () => undefined,
    logger: {
      debug: () => undefined,
      error: () => undefined,
      warn: () => undefined,
      info: () => undefined,
    },
  } as unknown as IAgentRuntime;
}

function signupForm(): FormDefinition {
  return {
    id: "signup",
    name: "Signup",
    controls: [
      { key: "name", label: "Name", type: "text", required: true },
      { key: "email", label: "Email", type: "email", required: true },
    ],
  };
}

describe("FormService stash/restore across same-room restart (issue #22272)", () => {
  let service: FormService;

  beforeEach(async () => {
    service = (await FormService.start(makeRuntime())) as FormService;
    service.registerForm(signupForm());
  });

  it("restores a stashed session after a new form starts in the same room", async () => {
    const first = await service.startSession("signup", entityId, roomId);
    await service.stash(first.id, entityId);

    // Start a brand-new form in the SAME room. Before the fix this overwrote the
    // stashed session's component (both keyed form_session:{roomId}), silently
    // destroying the user's stashed work.
    const second = await service.startSession("signup", entityId, roomId);
    expect(second.id).not.toBe(first.id);

    // Stashed session must still be retrievable.
    const stashed = await service.getStashedSessions(entityId);
    expect(stashed.map((s) => s.id)).toEqual([first.id]);

    // Clear the room so restore's active-session guard is satisfied.
    await service.cancel(second.id, entityId, true);

    const restored = await service.restore(first.id, entityId);
    expect(restored.id).toBe(first.id);
    expect(restored.status).toBe("active");

    const active = await service.getActiveSession(entityId, roomId);
    expect(active?.id).toBe(first.id);
  });

  it("still rejects a second active session in the same room", async () => {
    const first = await service.startSession("signup", entityId, roomId);
    expect(first.id).toBeTruthy();

    // A second active session in the same room must be rejected while one is
    // already active/ready. The keying fix must not weaken this invariant.
    await expect(
      service.startSession("signup", entityId, roomId),
    ).rejects.toThrow(/Active session already exists/);
  });
});
