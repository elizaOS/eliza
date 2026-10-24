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
import { getAutofillData, saveAutofillData } from "./storage";

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

  it("removes a sensitive value that a legacy record already holds", async () => {
    const runtime = harness.runtime;
    const entityId = stringToUuid("form-autofill-legacy-read");
    await runtime.createEntity({
      id: entityId,
      names: ["Ann"],
      agentId: runtime.agentId,
    });
    // The record the pre-guard submission path wrote: every submitted value,
    // including the password.
    await saveAutofillData(runtime, entityId, "login-autofill", {
      user: "ann",
      password: SECRET,
    });
    expect(
      (await getAutofillData(runtime, entityId, "login-autofill"))?.values
        .password,
    ).toBe(SECRET);

    const read = await service.getAutofill(entityId, "login-autofill");
    expect(read?.user).toBe("ann");
    expect(read?.password).toBeUndefined();

    // The secret must leave storage, not only the returned object: the
    // exported storage reader has no form definition and would otherwise keep
    // handing the password to every caller.
    const storedAfter = await getAutofillData(
      runtime,
      entityId,
      "login-autofill",
    );
    expect(storedAfter?.values).toEqual({ user: "ann" });
  }, 60_000);

  it("scrubs a legacy value while replaying it into the next session", async () => {
    const runtime = harness.runtime;
    const entityId = stringToUuid("form-autofill-legacy-replay");
    await runtime.createEntity({
      id: entityId,
      names: ["Ann"],
      agentId: runtime.agentId,
    });
    await saveAutofillData(runtime, entityId, "login-autofill", {
      user: "ann",
      password: SECRET,
    });
    const roomId = stringToUuid("form-autofill-legacy-replay-room");
    await runtime.ensureRoomExists({
      id: roomId,
      worldId: runtime.agentId,
      name: "Form autofill legacy replay",
      source: "test",
      type: ChannelType.DM,
    });

    const session = await service.startSession(
      "login-autofill",
      entityId,
      roomId,
    );
    const applied = await service.applyAutofill(session);
    expect(applied).toEqual(["user"]);

    const reloaded = await service.getActiveSession(entityId, roomId);
    expect(reloaded?.fields?.user?.value).toBe("ann");
    expect(reloaded?.fields?.password?.value).toBeUndefined();
    const storedAfter = await getAutofillData(
      runtime,
      entityId,
      "login-autofill",
    );
    expect(storedAfter?.values).toEqual({ user: "ann" });
  }, 60_000);
});
