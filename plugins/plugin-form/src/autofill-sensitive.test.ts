/**
 * A submitted sensitive answer must not become a prefill value. The autofill
 * record is replayed into the next session of the same form, so storing a
 * password there keeps the secret in a second record and answers the field
 * again without the user typing it. Runs the real FormService on a real
 * AgentRuntime with the PGlite store.
 */
import { ChannelType, stringToUuid } from "@elizaos/core";
import { createTestRuntime } from "@elizaos/testing/runtime";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import formPlugin from "./index";
import { FormService } from "./service";

const SECRET = "hunter123";

describe("sensitive answer in form autofill", () => {
  let harness: Awaited<ReturnType<typeof createTestRuntime>>;
  let service: FormService;

  beforeAll(async () => {
    harness = await createTestRuntime({
      characterName: "FormAutofillSensitive",
      plugins: [formPlugin],
    });
    const runtime = harness.runtime;
    await runtime.getServiceLoadPromise(FormService.serviceType);
    const formService = runtime.getService<FormService>(
      FormService.serviceType,
    );
    if (!formService) {
      throw new Error("FormService is not registered on this runtime");
    }
    service = formService;
    await runtime.createWorld({
      id: runtime.agentId,
      name: "Form autofill sensitive",
      agentId: runtime.agentId,
    });
    service.registerForm({
      id: "login-autofill",
      name: "Login autofill",
      ux: { allowAutofill: true },
      controls: [
        { key: "user", label: "User", type: "text", required: true },
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

  it("is not stored and not filled into the next session", async () => {
    const runtime = harness.runtime;
    const entityId = runtime.agentId;
    const firstRoom = stringToUuid("form-autofill-sensitive-first");
    await runtime.ensureRoomExists({
      id: firstRoom,
      worldId: runtime.agentId,
      name: "Form autofill sensitive",
      source: "test",
      type: ChannelType.DM,
    });
    const first = await service.startSession(
      "login-autofill",
      entityId,
      firstRoom,
    );
    await service.updateField(first.id, entityId, "user", "ann", 1, "manual");
    await service.updateField(
      first.id,
      entityId,
      "password",
      SECRET,
      1,
      "manual",
    );
    await service.submit(first.id, entityId);

    const stored = await service.getAutofill(entityId, "login-autofill");
    expect(stored?.user).toBe("ann");
    expect(stored?.password).toBeUndefined();

    const nextRoom = stringToUuid("form-autofill-sensitive-next");
    await runtime.ensureRoomExists({
      id: nextRoom,
      worldId: runtime.agentId,
      name: "Form autofill sensitive next",
      source: "test",
      type: ChannelType.DM,
    });
    const next = await service.startSession(
      "login-autofill",
      entityId,
      nextRoom,
    );
    await service.applyAutofill(next);
    const reloaded = await service.getActiveSession(entityId, nextRoom);
    expect(reloaded?.fields?.user?.value).toBe("ann");
    expect(reloaded?.fields?.password?.status).toBe("empty");
    expect(reloaded?.fields?.password?.value).toBeUndefined();
  }, 60_000);
});
