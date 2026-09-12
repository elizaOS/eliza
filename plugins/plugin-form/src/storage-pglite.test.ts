/**
 * Round-trips form components through a real AgentRuntime and PGlite adapter.
 * Session, submission, and autofill publication must accept the safe serializer's
 * null-prototype data while preserving own keys and rejecting getters pre-write.
 */
import assert from "node:assert/strict";
import { ChannelType, type JsonValue, stringToUuid } from "@elizaos/core";
import { createTestRuntime } from "@elizaos/core/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import formPlugin from "./index";
import { FormService } from "./service";
import {
  FORM_COMPONENT_DATA_UNBOUNDED,
  getAutofillData,
  getSessionById,
  getSubmissions,
  saveAutofillData,
  saveSession,
  saveSubmission,
  toComponentData,
} from "./storage";
import type { FormSubmission } from "./types";

function ownKeysPayload(value: string): Record<string, JsonValue> {
  return JSON.parse(
    `{"__proto__":{"polluted":"${value}"},"constructor":"${value}","prototype":{"value":"${value}"}}`,
  );
}

describe("form component SQL publication", () => {
  let harness: Awaited<ReturnType<typeof createTestRuntime>>;
  let service: FormService;
  const roomId = stringToUuid("form-component-sql-room");

  beforeAll(async () => {
    harness = await createTestRuntime({
      characterName: "FormComponentSql",
      plugins: [formPlugin],
    });
    const runtime = harness.runtime;
    await runtime.getServiceLoadPromise(FormService.serviceType);
    const formService = runtime.getService<FormService>(
      FormService.serviceType,
    );
    assert(formService);
    service = formService;
    const worldId = runtime.agentId;
    await runtime.createWorld({
      id: worldId,
      name: "Form storage",
      agentId: runtime.agentId,
    });
    await runtime.ensureRoomExists({
      id: roomId,
      worldId,
      name: "Form storage",
      source: "test",
      type: ChannelType.DM,
    });
    // Session-independent submission/autofill components use the agent context.
    await runtime.ensureRoomExists({
      id: runtime.agentId,
      worldId,
      name: "Agent forms",
      source: "test",
      type: ChannelType.DM,
    });
    service.registerForm({
      id: "signup",
      name: "Signup",
      controls: [{ key: "name", label: "Name", type: "text" }],
    });
  }, 180_000);

  afterAll(async () => {
    await harness?.cleanup();
  }, 60_000);

  it("persists session and autofill updates and submissions without losing own JSON keys", async () => {
    const runtime = harness.runtime;
    const entityId = runtime.agentId;
    const session = await service.startSession("signup", entityId, roomId, {
      context: ownKeysPayload("initial"),
    });
    const created = await getSessionById(runtime, entityId, session.id);
    expect(created).toEqual(
      JSON.parse(JSON.stringify(toComponentData(session))),
    );

    session.meta = ownKeysPayload("updated");
    Object.defineProperty(session, "__proto__", {
      enumerable: true,
      value: { marker: "session-own-key" },
    });
    await saveSession(runtime, session);
    const updated = await getSessionById(runtime, entityId, session.id);
    expect(updated).toEqual(
      JSON.parse(JSON.stringify(toComponentData(session))),
    );
    expect(
      Object.getOwnPropertyDescriptor(updated, "__proto__")?.value,
    ).toEqual({ marker: "session-own-key" });

    const values = ownKeysPayload("autofill-created");
    await saveAutofillData(runtime, entityId, "signup", values);
    expect(
      (await getAutofillData(runtime, entityId, "signup"))?.values,
    ).toEqual(values);
    const replacement = ownKeysPayload("autofill-updated");
    await saveAutofillData(runtime, entityId, "signup", replacement);
    expect(
      (await getAutofillData(runtime, entityId, "signup"))?.values,
    ).toEqual(replacement);

    const submission: FormSubmission = {
      id: stringToUuid("form-sql-submission"),
      formId: session.formId,
      formVersion: session.formVersion,
      sessionId: session.id,
      entityId,
      values: replacement,
      mappedValues: values,
      submittedAt: Date.now(),
    };
    Object.defineProperty(submission, "__proto__", {
      enumerable: true,
      value: { marker: "submission-own-key" },
    });
    await saveSubmission(runtime, submission);
    const submissions = await getSubmissions(runtime, entityId, session.formId);
    expect(submissions).toEqual([
      JSON.parse(JSON.stringify(toComponentData(submission))),
    ]);
    expect(
      Object.getOwnPropertyDescriptor(submissions[0], "__proto__")?.value,
    ).toEqual({ marker: "submission-own-key" });
    expect(
      Object.getOwnPropertyDescriptor(Object.prototype, "polluted"),
    ).toBeUndefined();

    const before = await runtime.getComponents(entityId);
    let getterCalls = 0;
    Object.defineProperty(session, "meta", {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return {};
      },
    });
    await expect(saveSession(runtime, session)).rejects.toThrow(
      expect.objectContaining({ code: FORM_COMPONENT_DATA_UNBOUNDED }),
    );
    const invalidValues: Record<string, JsonValue> = {};
    Object.defineProperty(invalidValues, "bad", {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return "bad";
      },
    });
    await expect(
      saveAutofillData(runtime, entityId, "signup", invalidValues),
    ).rejects.toThrow(
      expect.objectContaining({ code: FORM_COMPONENT_DATA_UNBOUNDED }),
    );
    await expect(
      saveSubmission(runtime, { ...submission, values: invalidValues }),
    ).rejects.toThrow(
      expect.objectContaining({ code: FORM_COMPONENT_DATA_UNBOUNDED }),
    );
    expect(getterCalls).toBe(0);
    expect(await runtime.getComponents(entityId)).toEqual(before);
  }, 60_000);
});
