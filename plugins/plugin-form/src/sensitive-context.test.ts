/**
 * A sensitive field must not reach the model context or a reply, filled or
 * uncertain. Runs the real FORM_CONTEXT provider and FORM restore action on a
 * real AgentRuntime with the PGlite store.
 */
import assert from "node:assert/strict";
import {
  ChannelType,
  type Content,
  type Memory,
  type State,
  stringToUuid,
} from "@elizaos/core";
import { createTestRuntime } from "@elizaos/testing/runtime";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { formAction } from "./actions/form";
import formPlugin from "./index";
import { formContextProvider } from "./providers/context";
import { FormService } from "./service";

const SECRET = "hunter123";

describe("sensitive field in provider context and restore reply", () => {
  let harness: Awaited<ReturnType<typeof createTestRuntime>>;
  let service: FormService;
  const roomId = stringToUuid("form-sensitive-room");

  beforeAll(async () => {
    harness = await createTestRuntime({
      characterName: "FormSensitive",
      plugins: [formPlugin],
    });
    const runtime = harness.runtime;
    await runtime.getServiceLoadPromise(FormService.serviceType);
    const formService = runtime.getService<FormService>(
      FormService.serviceType,
    );
    assert(formService);
    service = formService;
    await runtime.createWorld({
      id: runtime.agentId,
      name: "Form sensitive",
      agentId: runtime.agentId,
    });
    await runtime.ensureRoomExists({
      id: roomId,
      worldId: runtime.agentId,
      name: "Form sensitive",
      source: "test",
      type: ChannelType.DM,
    });
    service.registerForm({
      id: "login",
      name: "Login",
      controls: [
        {
          key: "password",
          label: "Password",
          type: "text",
          required: true,
          sensitive: true,
        },
      ],
    });
  }, 180_000);

  afterAll(async () => {
    await harness?.cleanup();
  }, 60_000);

  const message = (): Memory =>
    ({
      entityId: harness.runtime.agentId,
      roomId,
      agentId: harness.runtime.agentId,
      content: { text: "restore my form" },
    }) as Memory;

  it("masks the value when it is filled and when it is uncertain", async () => {
    const runtime = harness.runtime;
    const entityId = runtime.agentId;
    const session = await service.startSession("login", entityId, roomId);

    await service.updateField(
      session.id,
      entityId,
      "password",
      SECRET,
      0.2,
      "extraction",
    );
    const uncertain = await formContextProvider.get(
      runtime,
      message(),
      {} as State,
    );
    expect(uncertain.text).toContain("Password");
    expect(uncertain.text).not.toContain(SECRET);

    await service.updateField(
      session.id,
      entityId,
      "password",
      SECRET,
      1,
      "manual",
    );
    const filled = await formContextProvider.get(
      runtime,
      message(),
      {} as State,
    );
    expect(filled.text).toContain("****");
    expect(filled.text).not.toContain(SECRET);

    await service.stash(session.id, entityId);
    const replies: Content[] = [];
    await formAction.handler(
      runtime,
      message(),
      undefined,
      undefined,
      async (c) => {
        replies.push(c);
        return [];
      },
    );
    expect(replies[0]?.text).toContain("Password: ****");
    expect(replies.map((r) => r.text).join("\n")).not.toContain(SECRET);
  }, 60_000);
});
