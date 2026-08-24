/**
 * Regression coverage for FormService required-field gating on unsatisfied
 * external and uncertain fields. Deterministic, no live model: a custom
 * `payment` external control type is registered against the component-store
 * mock, then the ready-transition and submit() gate are exercised while a
 * required field is `pending` (activated, valueless) or `uncertain`
 * (low-confidence extraction). Proves that submit() rejects and no
 * value-dropping FormSubmission is recorded until the field is genuinely
 * satisfied, and that confirmation/acceptance re-opens the happy path.
 */
import type { Component, IAgentRuntime, UUID } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FormService } from "./service";
import type { ControlType, FormDefinition } from "./types";

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
    getTaskWorker: vi.fn(() => undefined),
    logger: {
      debug: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
    },
  } as unknown as IAgentRuntime;
}

const paymentType: ControlType = {
  id: "payment",
  activate: async () => ({
    reference: "pay-ref-1",
    instructions: "Send 0.5 SOL to the address to complete checkout",
    address: "SoLPaYmEnTaDdReSs",
  }),
};

function checkoutForm(): FormDefinition {
  return {
    id: "checkout",
    name: "Checkout",
    controls: [
      { key: "pay", label: "Payment", type: "payment", required: true },
    ],
  };
}

describe("FormService required external field gating", () => {
  let service: FormService;

  beforeEach(async () => {
    service = (await FormService.start(makeRuntime())) as FormService;
    service.registerControlType(paymentType);
  });

  it("rejects submit() while a required external field is pending and confirmed value re-opens it", async () => {
    service.registerForm(checkoutForm());

    const session = await service.startSession("checkout", entityId, roomId);

    // Activate the external payment: status becomes "pending" with NO value.
    await service.activateExternalField(session.id, entityId, "pay");

    const activated = await service.getActiveSession(entityId, roomId);
    expect(activated?.fields.pay?.status).toBe("pending");
    expect(activated?.fields.pay?.value).toBeUndefined();
    // A pending required external field must NOT flip the session to ready.
    expect(activated?.status).toBe("active");

    // submit() must throw rather than record a value-dropping submission.
    await expect(service.submit(session.id, entityId)).rejects.toThrow(
      "Not all required fields are filled",
    );

    // No submission should have been recorded by the rejected submit.
    await expect(service.getSubmissions(entityId, "checkout")).resolves.toEqual(
      [],
    );

    // Confirm the external field -> status "filled" with a real value.
    await service.confirmExternalField(
      session.id,
      entityId,
      "pay",
      "confirmed",
      {
        txId: "tx-abc",
      },
    );

    const confirmed = await service.getActiveSession(entityId, roomId);
    expect(confirmed?.fields.pay?.status).toBe("filled");
    expect(confirmed?.status).toBe("ready");

    // Now submit succeeds and the submission includes the required field.
    const submission = await service.submit(session.id, entityId);
    expect(submission.values.pay).toBe("confirmed");
    expect(submission.mappedValues?.pay).toBe("confirmed");

    const recorded = await service.getSubmissions(entityId, "checkout");
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.values.pay).toBe("confirmed");
  });

  it("does not flip to ready and blocks submit() while a required field is uncertain", async () => {
    service.registerForm({
      id: "profile",
      name: "Profile",
      controls: [
        { key: "email", label: "Email", type: "email", required: true },
      ],
    });

    const session = await service.startSession("profile", entityId, roomId);

    // Low-confidence extraction -> status "uncertain" (has a value, but unmet).
    await service.updateField(
      session.id,
      entityId,
      "email",
      "jane@example.com",
      0.2,
      "extraction",
    );

    const uncertain = await service.getActiveSession(entityId, roomId);
    expect(uncertain?.fields.email?.status).toBe("uncertain");
    // An uncertain required field must not be treated as complete.
    expect(uncertain?.status).toBe("active");

    await expect(service.submit(session.id, entityId)).rejects.toThrow(
      "Not all required fields are filled",
    );

    // Accepting the uncertain value satisfies the gate.
    await service.confirmField(session.id, entityId, "email", true);

    const accepted = await service.getActiveSession(entityId, roomId);
    expect(accepted?.fields.email?.status).toBe("filled");

    const submission = await service.submit(session.id, entityId);
    expect(submission.values.email).toBe("jane@example.com");
  });
});
