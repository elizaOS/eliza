/** Device fences bind the auth subject to the mapped owner entity only through the authenticated request caller. */
import type { ContextObject, IAgentRuntime, Memory } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  currentReminderRecordSource,
  DeviceActionService,
  setDeviceReadReplyContext,
  withDeviceActionTurn,
} from "./service.ts";

const agentId = "11111111-1111-4111-8111-111111111111";
// Production subjects are auth identities; the message carries the owner UUID.
const subject = "gateway:owner-principal";
const owner = "22222222-2222-4222-8222-222222222222";
const revision = "a".repeat(64);
const reminder = {
  kind: "reminder",
  id: "reminder-1",
  occurrenceId: "occurrence-1",
  revision,
  accountId: "reminders-source",
  sourceRevision: revision,
};

afterEach(() => vi.restoreAllMocks());

async function reminderSource(
  role: string,
  selectedObject: Record<string, unknown> | null = reminder,
) {
  const runtime = {
    agentId,
    getSetting: () => undefined,
    actions: [],
    getService: () => null,
    logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
  } as unknown as IAgentRuntime;
  const message = {
    id: "33333333-3333-4333-8333-333333333333",
    agentId,
    entityId: owner,
    roomId: "55555555-5555-4555-8555-555555555555",
    content: {
      text: "Cancel this reminder.",
      metadata: {
        clientDevice: {
          context: {
            revision: 1,
            view: "calendar",
            sensitive: false,
            timeZone: "America/Los_Angeles",
            ...(selectedObject ? { selectedObject } : {}),
          },
        },
      },
    },
  } as Memory;
  vi.spyOn(DeviceActionService.prototype, "viewProfile").mockResolvedValue(
    null,
  );
  return withDeviceActionTurn(
    runtime,
    {
      subjectUserId: subject,
      installationId: "installation",
      deviceKey: "key",
      capabilities: ["reminders.local-record.v1"],
    },
    async () => {
      try {
        setDeviceReadReplyContext(runtime, message, {} as ContextObject);
      } catch {
        // A non-owner caller cannot bind the request; the fence stays closed.
      }
      return currentReminderRecordSource(runtime);
    },
    {
      isCurrent: () => true,
      requestCaller: { subjectUserId: subject, entityId: owner, role },
    },
  );
}

describe("currentReminderRecordSource", () => {
  it("routes the authenticated owner's selected native reminder to the device", async () => {
    expect(await reminderSource("OWNER")).toBe("device");
  });

  it("keeps a non-owner caller on the runtime store", async () => {
    expect(await reminderSource("USER")).toBe("runtime");
  });

  it("keeps an owner turn without a reminder selection on the runtime store", async () => {
    expect(await reminderSource("OWNER", null)).toBe("runtime");
  });
});
