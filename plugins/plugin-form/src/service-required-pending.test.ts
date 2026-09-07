/**
 * Pins that a required control is satisfied only by a filled field. A field
 * whose external activation is still pending, or whose value is uncertain,
 * must neither flip the session to ready nor pass submission. Exercises the
 * real FormService against an in-memory component store; no transport.
 */
import type { Component, IAgentRuntime, UUID } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FormService } from "./service";
import type { FieldState, FormDefinition } from "./types";

const entityId = "00000000-0000-4000-8000-000000000201" as UUID;
const roomId = "00000000-0000-4000-8000-000000000202" as UUID;
const agentId = "00000000-0000-4000-8000-000000000203" as UUID;

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
    deleteComponent: vi.fn(async (id: UUID) => {
      for (const [key, component] of components) {
        if (component.id === id) components.delete(key);
      }
    }),
    emitEvent: vi.fn(async () => undefined),
    registerTaskWorker: vi.fn(),
    logger: { debug: vi.fn(), error: vi.fn(), warn: vi.fn(), info: vi.fn() },
  } as unknown as IAgentRuntime;
}

const form: FormDefinition = {
  id: "payment",
  name: "Payment",
  controls: [
    { key: "wallet", label: "Wallet", type: "text", required: true },
    { key: "note", label: "Note", type: "text", required: false },
  ],
};

describe("required fields that are not yet filled", () => {
  let service: FormService;

  beforeEach(async () => {
    service = (await FormService.start(makeRuntime())) as FormService;
    service.registerForm(form);
  });

  async function sessionWithRequiredState(state: FieldState): Promise<string> {
    const session = await service.startSession("payment", entityId, roomId);
    session.fields.wallet = state;
    await service.saveSession(session);
    return session.id;
  }

  it.each([
    ["pending external activation", { status: "pending" } satisfies FieldState],
    [
      "an uncertain value",
      { status: "uncertain", value: "0xabc", confidence: 0.3 } as FieldState,
    ],
  ])(
    "does not become ready or submit while the wallet is %s",
    async (_label, state) => {
      const sessionId = await sessionWithRequiredState(state);

      // Filling the optional field re-evaluates readiness; the required field
      // has no committed value yet, so the session must stay active.
      await service.updateField(sessionId, entityId, "note", "hi", 1, "user");
      const session = await service.getActiveSession(entityId, roomId);
      expect(session?.status).toBe("active");

      await expect(service.submit(sessionId, entityId)).rejects.toThrow(
        /Not all required fields are filled/,
      );
    },
  );

  it("becomes ready and submits once the required field is filled", async () => {
    const session = await service.startSession("payment", entityId, roomId);
    await service.updateField(
      session.id,
      entityId,
      "wallet",
      "0xabc",
      1,
      "user",
    );
    const ready = await service.getActiveSession(entityId, roomId);
    expect(ready?.status).toBe("ready");
    const submission = await service.submit(session.id, entityId);
    expect(submission.values.wallet).toBe("0xabc");
  });
});
