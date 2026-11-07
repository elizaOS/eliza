/**
 * A plugin extends a built-in control type the way builtins.ts documents:
 * `getBuiltinType(id)`, spread, replace a method, then
 * `registerControlType(type, { allowOverride: true })`. The copy keeps
 * `builtin: true`. Runs the real form evaluator processors and submit on a
 * real AgentRuntime with the PGlite store. No live model is used; the
 * processors receive the parsed model output directly.
 */
import assert from "node:assert/strict";
import {
  ChannelType,
  type Memory,
  type State,
  stringToUuid,
  type UUID,
} from "@elizaos/core";
import { createTestRuntime } from "@elizaos/testing/runtime";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getBuiltinType } from "./builtins";
import { formEvaluator } from "./evaluators/extractor";
import formPlugin from "./index";
import { FormService } from "./service";
import type { ExtractionResult } from "./types";

function requireDefined<T>(value: T | undefined, what: string): T {
  if (value === undefined) {
    throw new Error(`Form extended-type harness requires ${what}`);
  }
  return value;
}

const prepare = requireDefined(formEvaluator.prepare, "the evaluator prepare");
const processors = formEvaluator.processors ?? [];

const state: State = { values: {}, data: {}, text: "" };

describe("extended built-in control type", () => {
  let harness: Awaited<ReturnType<typeof createTestRuntime>>;
  let service: FormService;
  let entityId: UUID;

  beforeAll(async () => {
    harness = await createTestRuntime({
      characterName: "FormExtendedType",
      plugins: [formPlugin],
    });
    const runtime = harness.runtime;
    await runtime.getServiceLoadPromise(FormService.serviceType);
    const formService = runtime.getService<FormService>(
      FormService.serviceType,
    );
    assert(formService);
    service = formService;
    entityId = runtime.agentId;
    await runtime.createWorld({
      id: runtime.agentId,
      name: "Form extended type",
      agentId: runtime.agentId,
    });

    const email = requireDefined(getBuiltinType("email"), "built-in email");
    service.registerControlType(
      {
        ...email,
        validate: (value) =>
          String(value).toLowerCase().endsWith("@acme.com")
            ? { valid: true }
            : { valid: false, error: "Use your acme.com work email" },
      },
      { allowOverride: true },
    );
    const number = requireDefined(getBuiltinType("number"), "built-in number");
    service.registerControlType(
      {
        ...number,
        parse: (value) =>
          /^\d+k$/i.test(value.trim())
            ? Number.parseInt(value, 10) * 1000
            : Number(value),
      },
      { allowOverride: true },
    );

    service.registerForm({
      id: "order",
      name: "Order",
      controls: [
        { key: "email", label: "Email", type: "email", required: true },
        {
          key: "budget",
          label: "Budget",
          type: "number",
          required: true,
          max: 10_000,
        },
      ],
    });
  }, 180_000);

  afterAll(async () => {
    await harness?.cleanup();
  }, 60_000);

  async function openForm(name: string): Promise<UUID> {
    const roomId = stringToUuid(`form-extended-type-room-${name}`);
    await harness.runtime.ensureRoomExists({
      id: roomId,
      worldId: harness.runtime.agentId,
      name,
      source: "test",
      type: ChannelType.DM,
    });
    await service.startSession("order", entityId, roomId);
    return roomId;
  }

  /** One user turn: the evaluator's processors run on the parsed model output. */
  async function turn(
    roomId: UUID,
    text: string,
    formExtractions: ExtractionResult[],
  ): Promise<void> {
    const message: Memory = {
      id: stringToUuid(`${roomId}:${text}`),
      entityId,
      agentId: harness.runtime.agentId,
      roomId,
      content: { text },
    };
    const context = { runtime: harness.runtime, message, state, options: {} };
    const prepared = await prepare(context);
    const output = { formIntent: "fill_form" as const, formExtractions };
    for (const processor of processors) {
      await processor.process({
        ...context,
        prepared,
        output,
        evaluatorName: formEvaluator.name,
      });
    }
  }

  async function fields(roomId: UUID) {
    const session = await service.getActiveSession(entityId, roomId);
    assert(session);
    return session.fields;
  }

  it("checks an answer with the plugin's validate", async () => {
    const roomId = await openForm("validate");
    await turn(roomId, "mail me at ann@gmail.com, budget 5000", [
      { field: "email", value: "ann@gmail.com", confidence: 0.95 },
      { field: "budget", value: 5000, confidence: 0.95 },
    ]);
    expect((await fields(roomId)).email).toMatchObject({
      status: "invalid",
      error: "Use your acme.com work email",
    });

    await turn(roomId, "use ann@acme.com", [
      { field: "email", value: "ann@acme.com", confidence: 0.95 },
    ]);
    expect((await fields(roomId)).email).toMatchObject({
      status: "filled",
      value: "ann@acme.com",
    });
  }, 60_000);

  it("reads an answer with the plugin's parse and keeps the field bounds", async () => {
    const roomId = await openForm("parse");
    await turn(roomId, "ann@acme.com, about 50k", [
      { field: "email", value: "ann@acme.com", confidence: 0.95 },
      { field: "budget", value: "50k", confidence: 0.95 },
    ]);
    expect((await fields(roomId)).budget).toMatchObject({
      status: "invalid",
      value: 50_000,
      error: "Budget must be at most 10000",
    });

    await turn(roomId, "make it 5k", [
      { field: "budget", value: "5k", confidence: 0.95 },
    ]);
    expect((await fields(roomId)).budget).toMatchObject({
      status: "filled",
      value: 5000,
    });

    const session = await service.getActiveSession(entityId, roomId);
    assert(session);
    expect(session.status).toBe("ready");
    const submission = await service.submit(session.id, entityId);
    expect(submission.values).toEqual({ email: "ann@acme.com", budget: 5000 });
  }, 60_000);
});
