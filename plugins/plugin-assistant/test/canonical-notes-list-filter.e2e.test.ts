import { randomUUID } from "node:crypto";
import { NOTES_LIST_FILTER_CAPABILITY } from "@elizaos/contracts";
import { type Memory, resolveOwnerEntityIdOrDefault } from "@elizaos/core";
import { expect, test } from "vitest";
import { createTestRuntime } from "../../../packages/testing/src/pglite-runtime.ts";
import {
  DeviceActionService,
  setDeviceActionRequestMessage,
} from "../src/services/device-actions/service.ts";
import { deviceActionTools } from "../src/services/device-actions/tools.ts";
import { withOwnerDeviceActionTurn } from "./device-owner-turn.ts";

test("registered canonical Notes filter admits one exact SQL proposal for the current list", async () => {
  const { runtime, cleanup } = await createTestRuntime({
    characterName: "CanonicalNotesFilter",
  });
  try {
    const service = new DeviceActionService(runtime);
    const credential = {
      subjectUserId: resolveOwnerEntityIdOrDefault(runtime),
      installationId: randomUUID(),
      deviceKey: "a".repeat(64),
      capabilities: [NOTES_LIST_FILTER_CAPABILITY],
    };
    const enrollment = await service.register(
      credential,
      "Notes filter fixture",
    );
    expect(enrollment.capabilities).toContain(NOTES_LIST_FILTER_CAPABILITY);
    const tool = deviceActionTools.find(
      (action) => action.name === "DEVICE_CANONICAL_NOTES_FILTER",
    );
    if (!tool?.validate || !tool.handler)
      throw new Error("Expected the canonical Notes action");
    const { validate, handler } = tool;
    runtime.registerAction(tool);
    const operation = { type: "notes_list_filter", kind: "list" };
    const old = {
      ...credential,
      capabilities: ["notes.local-record.v1", "notes.organize.v1"],
    };
    const canonical = {
      kind: "canonical-note-source",
      id: "notes",
      revision: "12",
    };
    const ask = async (
      selectedObject: Record<string, string>,
      device = credential,
    ) => {
      const message: Memory = {
        id: randomUUID(),
        agentId: runtime.agentId,
        entityId: credential.subjectUserId,
        roomId: randomUUID(),
        content: {
          text: "Show my checklists in Notes",
          metadata: {
            clientDevice: {
              context: {
                view: "notes",
                sensitive: false,
                revision: 2,
                selectedObject,
              },
            },
          },
        },
      };
      return withOwnerDeviceActionTurn(runtime, device, async () => {
        setDeviceActionRequestMessage(runtime, message);
        if (!(await validate(runtime, message))) return false;
        return handler(runtime, message, undefined, {
          parameters: {
            operation,
            operationKey: randomUUID(),
            reason: "Fixture",
          },
        });
      });
    };
    await expect(
      service.propose(credential, operation, "unbound-filter", "Fixture"),
    ).rejects.toThrow("record authority");
    expect(
      await ask({
        kind: "legacy-app-notes-source",
        id: "previous-notes",
        accountId: "device-local-legacy",
      }),
    ).toBe(false);
    expect(await ask(canonical, old)).toBe(false);
    expect(await service.list(credential)).toEqual([]);
    expect(await ask(canonical)).toMatchObject({ success: true });
    const proposals = await service.list(credential);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({
      state: "pending",
      payload: { operation },
    });
    expect(await service.list(old)).toEqual([]);
  } finally {
    await cleanup();
  }
});
