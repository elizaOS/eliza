/**
 * A hidden field is extracted silently and never asked for (`hidden` in
 * types.ts, `.hidden()` in the builder). Runs the real form evaluator prompt
 * and processors, the FORM_CONTEXT provider and submit on a real AgentRuntime
 * with the PGlite store. No live model is used; the processors receive the
 * parsed model output directly.
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
import { formEvaluator } from "./evaluators/extractor";
import formPlugin from "./index";
import { formContextProvider } from "./providers/context";
import { FormService } from "./service";
import type { ExtractionResult } from "./types";

function requireDefined<T>(value: T | undefined, what: string): T {
  if (value === undefined) {
    throw new Error(`Form hidden-field harness requires ${what}`);
  }
  return value;
}

const prepare = requireDefined(formEvaluator.prepare, "the evaluator prepare");
const processors = formEvaluator.processors ?? [];

const state: State = { values: {}, data: {}, text: "" };

describe("hidden form field", () => {
  let harness: Awaited<ReturnType<typeof createTestRuntime>>;
  let service: FormService;
  let entityId: UUID;

  beforeAll(async () => {
    harness = await createTestRuntime({
      characterName: "FormHidden",
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
      name: "Form hidden",
      agentId: runtime.agentId,
    });
    service.registerForm({
      id: "lead",
      name: "Lead",
      controls: [
        { key: "name", label: "Name", type: "text", required: true },
        {
          key: "referral",
          label: "Referral source",
          type: "text",
          hidden: true,
          description: "Where the user heard about us",
        },
        {
          key: "work_email",
          label: "Work email",
          type: "email",
          hidden: true,
        },
      ],
    });
  }, 180_000);

  afterAll(async () => {
    await harness?.cleanup();
  }, 60_000);

  async function openForm(name: string): Promise<UUID> {
    const roomId = stringToUuid(`form-hidden-room-${name}`);
    await harness.runtime.ensureRoomExists({
      id: roomId,
      worldId: harness.runtime.agentId,
      name,
      source: "test",
      type: ChannelType.DM,
    });
    await service.startSession("lead", entityId, roomId);
    return roomId;
  }

  function contextIn(roomId: UUID, text: string) {
    const message: Memory = {
      id: stringToUuid(`${roomId}:${text}`),
      entityId,
      agentId: harness.runtime.agentId,
      roomId,
      content: { text },
    };
    return { runtime: harness.runtime, message, state, options: {} };
  }

  /** The field keys the evaluator prompt describes to the model. */
  async function promptedKeys(roomId: UUID, text: string): Promise<string[]> {
    const context = contextIn(roomId, text);
    const prepared = await prepare(context);
    const prompt = formEvaluator.prompt({ ...context, prepared });
    const json = prompt.split("Context JSON:\n")[1]?.split("\n\nReturn:")[0];
    assert(json, "the evaluator prompt has a Context JSON block");
    return (JSON.parse(json).fields as Array<{ key: string }>).map(
      (field) => field.key,
    );
  }

  /** One user turn: the evaluator's processors run on the parsed model output. */
  async function turn(
    roomId: UUID,
    text: string,
    formExtractions: ExtractionResult[],
  ): Promise<void> {
    const context = contextIn(roomId, text);
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

  async function modelContextText(roomId: UUID): Promise<string> {
    const provider = await formContextProvider.get(
      harness.runtime,
      contextIn(roomId, "context").message,
      state,
    );
    return String(provider.text);
  }

  it("describes a hidden field to the extractor and fills it without asking", async () => {
    const text = "I'm Ann, I heard about you on a podcast";
    const roomId = await openForm("fill");

    expect(await promptedKeys(roomId, text)).toEqual([
      "name",
      "referral",
      "work_email",
    ]);

    await turn(roomId, text, [
      { field: "name", value: "Ann", confidence: 0.95 },
      { field: "referral", value: "a podcast", confidence: 0.9 },
    ]);
    const session = await service.getActiveSession(entityId, roomId);
    assert(session);
    expect(session.fields.referral).toMatchObject({
      status: "filled",
      value: "a podcast",
    });
    expect(session.status).toBe("ready");
    expect(await modelContextText(roomId)).not.toContain("referral");

    const submission = await service.submit(session.id, entityId);
    expect(submission.values).toMatchObject({
      name: "Ann",
      referral: "a podcast",
    });
  }, 60_000);

  it("drops a hidden answer that would need a confirmation or a re-ask", async () => {
    const roomId = await openForm("drop");
    await turn(roomId, "Ann here, maybe from a podcast, mail ann at work", [
      { field: "name", value: "Ann", confidence: 0.95 },
      { field: "referral", value: "maybe a podcast", confidence: 0.4 },
      { field: "work_email", value: "ann at work", confidence: 0.95 },
    ]);
    const session = await service.getActiveSession(entityId, roomId);
    assert(session);
    expect(session.fields.referral?.status ?? "empty").toBe("empty");
    expect(session.fields.work_email?.status ?? "empty").toBe("empty");
    expect(session.status).toBe("ready");

    const submission = await service.submit(session.id, entityId);
    expect(submission.values).toEqual({ name: "Ann" });
  }, 60_000);
});
