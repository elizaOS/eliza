/**
 * Exercises form evaluator admission and cancellation guidance through the real
 * service, provider, and processors with deterministic component persistence.
 * Stored components are copied so assertions observe saved state rather than
 * mutations to a caller's in-memory session. No live model is used.
 */
import assert from "node:assert/strict";
import type {
  Component,
  IAgentRuntime,
  Memory,
  State,
  UUID,
} from "@elizaos/core";
import { beforeEach, describe, expect, it } from "vitest";
import { formEvaluator } from "./evaluators/extractor";
import { formContextProvider } from "./providers/context";
import { FormService } from "./service";
import { getSessionById } from "./storage";

const prepare = formEvaluator.prepare;
const shouldRun = formEvaluator.shouldRun;
const processor = formEvaluator.processors?.find(
  (p) => p.name === "formIntent",
);
assert(
  prepare && shouldRun && processor,
  "Form evaluator lifecycle harness requires configured processors",
);

const entityId = "00000000-0000-4000-8000-000000000701" as UUID;
const roomId = "00000000-0000-4000-8000-000000000702" as UUID;
const agentId = "00000000-0000-4000-8000-000000000703" as UUID;
const message: Memory = {
  id: "00000000-0000-4000-8000-000000000704" as UUID,
  entityId,
  roomId,
  content: { text: "Cancel this form." },
};
const state: State = { values: {}, data: {}, text: "" };

function createRuntime() {
  const components = new Map<string, Component>();
  const key = (entity: UUID, type: string) => `${entity}:${type}`;
  let service: FormService;
  const runtime = {
    agentId,
    getService: () => service,
    getRoom: async () => ({ id: roomId, worldId: agentId }),
    getComponent: async (entity: UUID, type: string) =>
      structuredClone(components.get(key(entity, type))),
    getComponents: async (entity: UUID) =>
      structuredClone(
        Array.from(components.values()).filter((c) => c.entityId === entity),
      ),
    createComponent: async (component: Component) => {
      components.set(
        key(component.entityId, component.type),
        structuredClone(component),
      );
      return true;
    },
    updateComponent: async (component: Component) => {
      components.set(
        key(component.entityId, component.type),
        structuredClone(component),
      );
    },
    deleteComponent: async (id: UUID) => {
      for (const [componentKey, component] of components) {
        if (component.id === id) components.delete(componentKey);
      }
    },
    emitEvent: async () => undefined,
    registerTaskWorker: () => undefined,
    getTaskWorker: () => undefined,
  } as unknown as IAgentRuntime;
  return {
    runtime,
    setService: (value: FormService) => {
      service = value;
    },
  };
}

describe("form lifecycle outcomes", () => {
  let service: FormService;
  let runtime: IAgentRuntime;

  beforeEach(async () => {
    const harness = createRuntime();
    runtime = harness.runtime;
    service = (await FormService.start(runtime)) as FormService;
    harness.setService(service);
    service.registerForm({
      id: "signup",
      name: "Signup",
      controls: [{ key: "name", label: "Name", type: "text", required: true }],
    });
  });

  async function cancelThroughEvaluator() {
    const context = { runtime, message, state, options: {} };
    const prepared = await prepare(context);
    return processor.process({
      ...context,
      prepared,
      output: { formIntent: "cancel", formExtractions: [] },
      evaluatorName: formEvaluator.name,
    });
  }

  it("admits active forms, skips stashed forms, and prepares after restoration", async () => {
    const context = { runtime, message, state, options: {} };
    expect(await shouldRun(context)).toBe(false);
    const session = await service.startSession("signup", entityId, roomId);
    expect(await shouldRun(context)).toBe(true);
    await service.stash(session.id, entityId);
    expect(await shouldRun(context)).toBe(false);
    const saved = await formContextProvider.get(runtime, message, state);
    expect(saved.data?.stashedCount).toBe(1);
    expect(saved.data?.hasActiveForm).toBe(false);
    await service.restore(session.id, entityId);
    expect(await shouldRun(context)).toBe(true);
    const prepared = await prepare(context);
    expect(prepared.session.id).toBe(session.id);
    expect(prepared.session.status).toBe("active");
  });

  it.each(["active", "ready"] as const)(
    "retains a high-effort %s form and exposes cancellation confirmation before cancelling",
    async (status) => {
      const session = await service.startSession("signup", entityId, roomId);
      if (status === "ready") {
        await service.updateField(
          session.id,
          entityId,
          "name",
          "Alice",
          1,
          "manual",
        );
      }
      const stored = await service.getActiveSession(entityId, roomId);
      assert(stored);
      stored.effort.timeSpentMs = 15 * 60 * 1000;
      await service.saveSession(stored);
      await cancelThroughEvaluator();
      const pending = await service.getActiveSession(entityId, roomId);
      expect(pending?.status).toBe(status);
      expect(pending?.cancelConfirmationAsked).toBe(true);
      const provider = await formContextProvider.get(runtime, message, state);
      expect(provider.data?.pendingCancelConfirmation).toBe(true);
      // This is the actual model-facing instruction, selected from persisted
      // lifecycle state; a submission prompt here would lose the cancel request.
      const modelContext = JSON.parse(
        String(provider.text).split("form_context_json:\n")[1],
      );
      expect(modelContext.instruction).toMatch(/confirm.*lose progress/i);
      await cancelThroughEvaluator();
      expect(await service.getActiveSession(entityId, roomId)).toBeNull();
      expect(
        (await getSessionById(runtime, entityId, session.id))?.status,
      ).toBe("cancelled");
      const completed = await formContextProvider.get(runtime, message, state);
      expect(completed.data?.pendingCancelConfirmation).not.toBe(true);
    },
  );

  it("cancels a low-effort ready form immediately", async () => {
    const session = await service.startSession("signup", entityId, roomId);
    await service.updateField(
      session.id,
      entityId,
      "name",
      "Alice",
      1,
      "manual",
    );
    await cancelThroughEvaluator();
    expect(await service.getActiveSession(entityId, roomId)).toBeNull();
    expect((await getSessionById(runtime, entityId, session.id))?.status).toBe(
      "cancelled",
    );
    expect(await shouldRun({ runtime, message, state, options: {} })).toBe(
      false,
    );
  });
});
