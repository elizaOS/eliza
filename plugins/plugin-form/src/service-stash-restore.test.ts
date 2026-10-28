/**
 * Regression test for FormService stash/restore across a same-room restart
 * (issue #22272). Exercises the real FormService against an in-memory component
 * store that mirrors the runtime's natural-key (entityId, type) semantics, so
 * the stash -> start-new-form -> restore path is proven end to end. Deterministic,
 * no live model.
 */
import type { Component, IAgentRuntime, UUID } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { formAction } from "./actions/form";
import { FormService } from "./service";
import type { ControlType, FormDefinition } from "./types";

const entityId = "00000000-0000-4000-8000-000000000401" as UUID;
const roomId = "00000000-0000-4000-8000-000000000402" as UUID;
const agentId = "00000000-0000-4000-8000-000000000403" as UUID;

function makeRuntime(): IAgentRuntime {
  const components = new Map<string, Component>();
  let formService: FormService | undefined;
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
    getService: () => formService,
    setFormService: (service: FormService) => {
      formService = service;
    },
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
  let runtime: IAgentRuntime;

  beforeEach(async () => {
    runtime = makeRuntime();
    service = (await FormService.start(runtime)) as FormService;
    (
      runtime as unknown as { setFormService(s: FormService): void }
    ).setFormService(service);
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

  it("resuming from another room continues the form in that room", async () => {
    const otherRoomId = "00000000-0000-4000-8000-000000000404" as UUID;
    const first = await service.startSession("signup", entityId, roomId);
    await service.stash(first.id, entityId);
    // The original room now holds a different active form.
    const second = await service.startSession("signup", entityId, roomId);

    const message = {
      entityId,
      roomId: otherRoomId,
      content: { text: "resume my form" },
    } as unknown as Parameters<typeof formAction.handler>[1];
    const replies: string[] = [];
    const result = await formAction.handler(
      runtime,
      message,
      undefined,
      undefined,
      async (content) => {
        replies.push(String(content.text));
        return [];
      },
    );

    expect(result?.success).toBe(true);
    expect(replies[0]).toContain("restored");
    expect((await service.getActiveSession(entityId, otherRoomId))?.id).toBe(
      first.id,
    );
    expect((await service.getActiveSession(entityId, roomId))?.id).toBe(
      second.id,
    );
    expect(await service.getStashedSessions(entityId)).toEqual([]);
  });
});

const compositeControlType: ControlType = {
  id: "payment",
  getSubControls: () => [
    { key: "amount", type: "number", label: "Amount", required: true },
  ],
};

function checkoutForm(): FormDefinition {
  return {
    id: "checkout",
    name: "Checkout",
    controls: [
      { key: "payment", label: "Payment", type: "payment", required: true },
    ],
  };
}

describe("FormService session deadline on composite answers", () => {
  let service: FormService;

  beforeEach(async () => {
    const runtime = makeRuntime();
    service = (await FormService.start(runtime)) as FormService;
    (
      runtime as unknown as { setFormService(s: FormService): void }
    ).setFormService(service);
    service.registerControlType(compositeControlType);
    service.registerForm(checkoutForm());
  });

  it("extends the deadline when a subfield answer records effort", async () => {
    const session = await service.startSession("checkout", entityId, roomId);
    const createdDeadline = session.expiresAt;

    // The user answers the composite field one minute before the deadline.
    // That answer is effort, so the deadline must move forward from it.
    const nowSpy = vi
      .spyOn(Date, "now")
      .mockReturnValue(createdDeadline - 60_000);
    try {
      await service.updateSubField(
        session.id,
        entityId,
        "payment",
        "amount",
        90,
        0.95,
      );
    } finally {
      nowSpy.mockRestore();
    }

    const saved = await service.getActiveSession(entityId, roomId);
    expect(saved?.fields.payment.subFields?.amount.value).toBe(90);
    expect(saved?.expiresAt).toBeGreaterThan(createdDeadline);
  });
});
