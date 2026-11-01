import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MessagesSendOutcome } from "../telephony-profile.ts";

// Boundary fakes only: the native bridge, the system role API and the thread
// loader. The handler under test and the telephony profile module are real.
const sendFromMessages = vi.fn();
vi.mock("@elizaos/capacitor-system", () => ({
  System: { requestRole: vi.fn() },
}));
vi.mock("@elizaos/plugin-native-messages/bridge", () => ({
  Messages: { sendSms: vi.fn() },
}));
vi.mock("./messages-view-helpers.ts", () => ({
  loadMessagesState: vi.fn(),
  buildThreads: vi.fn(),
  smsRole: vi.fn(),
}));
vi.mock("../telephony-profile.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../telephony-profile.ts")>()),
  sendFromMessages,
}));

const { interact } = await import("./messages-interact.ts");

type ReviewedStatus = Extract<
  MessagesSendOutcome,
  { path: "reviewed" }
>["result"]["status"];

function reviewed(status: ReviewedStatus): MessagesSendOutcome {
  return {
    path: "reviewed",
    result: {
      kind: "sms-send",
      operationId: "messages-fictional-op",
      subscriptionId: 3,
      bindingHash: "fictional-binding",
      status,
      parts: [],
      createdAt: 1,
    },
  };
}

async function send(status: ReviewedStatus) {
  sendFromMessages.mockResolvedValueOnce(reviewed(status));
  return (await interact("send-sms", {
    address: "+15550100",
    body: "Fictional check-in: running ten minutes late.",
  })) as Record<string, unknown>;
}

describe("send-sms reports what the reviewed record proves", () => {
  beforeEach(() => sendFromMessages.mockReset());

  it("does not call a record written after the platform send started 'not sent'", async () => {
    for (const status of ["unknown", "failed"] as const) {
      const result = await send(status);
      expect(result).toMatchObject({
        sent: false,
        reviewed: true,
        status,
        disposition: "uncertain",
        resendSafe: false,
      });
      expect(String(result.receipt)).toMatch(
        /before sending again|Do not repeat/,
      );
    }
  });

  it("lets a record written before anything left the device be sent again", async () => {
    for (const status of ["cancelled", "denied"] as const) {
      const result = await send(status);
      expect(result).toMatchObject({
        sent: false,
        status,
        disposition: "not_sent",
        resendSafe: true,
      });
      expect(String(result.receipt)).toContain("not sent");
    }
  });

  it("reports submitted, sent and delivered records as sent", async () => {
    for (const status of ["submitted", "sent", "delivered"] as const) {
      const result = await send(status);
      expect(result).toMatchObject({
        sent: true,
        status,
        disposition: "sent",
        resendSafe: false,
      });
    }
  });
});
