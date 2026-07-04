/**
 * Covers the `interact` view-bundle capability handler (terminal list/send/role
 * capabilities). Render coverage for the unified spatial surface lives in
 * MessagesView.test.tsx and MessagesSpatialView.test.tsx.
 */

import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";

const bridge = vi.hoisted(() => ({
  listMessages: vi.fn(),
  sendSms: vi.fn(),
  getStatus: vi.fn(),
  requestRole: vi.fn(),
  requestPermissions: vi.fn(async () => ({ sms: "granted" })),
}));

vi.mock("@elizaos/capacitor-messages", () => ({
  Messages: {
    listMessages: bridge.listMessages,
    sendSms: bridge.sendSms,
    requestPermissions: bridge.requestPermissions,
  },
}));

vi.mock("@elizaos/capacitor-system", () => ({
  System: {
    getStatus: bridge.getStatus,
    requestRole: bridge.requestRole,
  },
}));

import { interact } from "./messages-interact";

const sampleMessages = [
  {
    id: "m1",
    threadId: "thread-a",
    address: "+15550100",
    body: "hello from alice",
    date: 1_700_000_000_000,
    type: 1,
    read: false,
  },
  {
    id: "m2",
    threadId: "thread-a",
    address: "+15550100",
    body: "reply to alice",
    date: 1_700_000_100_000,
    type: 2,
    read: true,
  },
  {
    id: "m3",
    threadId: "thread-b",
    address: "+15550200",
    body: "newer message",
    date: 1_700_000_200_000,
    type: 1,
    read: true,
  },
];

function mockBridge() {
  bridge.listMessages.mockResolvedValue({ messages: sampleMessages });
  bridge.sendSms.mockResolvedValue({
    messageId: "sent-1",
    messageUri: "content://sms/1",
  });
  bridge.getStatus.mockResolvedValue({
    packageName: "ai.eliza",
    roles: [
      {
        role: "sms",
        androidRole: "android.app.role.SMS",
        held: false,
        holders: ["com.android.messages"],
        available: true,
      },
    ],
  });
  bridge.requestRole.mockResolvedValue({
    role: "sms",
    held: true,
    resultCode: 0,
  });
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("interact — terminal capabilities", () => {
  it("supports terminal capabilities for list, send, and sms role request", async () => {
    mockBridge();

    await expect(interact("terminal-list-threads")).resolves.toMatchObject({
      viewType: "tui",
      ownsSmsRole: false,
      smsRoleHolder: "com.android.messages",
      threads: [
        {
          id: "thread-b",
          address: "+15550200",
          messageCount: 1,
          unreadCount: 0,
          lastMessage: "newer message",
        },
        {
          id: "thread-a",
          address: "+15550100",
          messageCount: 2,
          unreadCount: 1,
          lastMessage: "reply to alice",
        },
      ],
    });

    await expect(
      interact("terminal-send-sms", {
        address: "+15550300",
        body: "sent from test",
      }),
    ).resolves.toEqual({
      sent: true,
      address: "+15550300",
      bodyLength: 14,
      viewType: "tui",
    });
    expect(bridge.sendSms).toHaveBeenCalledWith({
      address: "+15550300",
      body: "sent from test",
    });

    await expect(interact("terminal-request-sms-role")).resolves.toMatchObject({
      requested: true,
      viewType: "tui",
    });
    expect(bridge.requestRole).toHaveBeenCalledWith({ role: "sms" });
  });

  it("clamps hostile terminal-list-threads limits before hitting the native bridge", async () => {
    mockBridge();

    await fc.assert(
      fc.asyncProperty(
        fc.oneof(
          fc.double({ noNaN: true }),
          fc.constant(Number.POSITIVE_INFINITY),
          fc.constant(Number.NEGATIVE_INFINITY),
          fc.constant(Number.NaN),
        ),
        async (limit) => {
          bridge.listMessages.mockClear();
          await interact("terminal-list-threads", { limit });

          const requested = bridge.listMessages.mock.calls[0]?.[0] as
            | { limit?: number }
            | undefined;
          expect(Number.isInteger(requested?.limit)).toBe(true);
          expect(requested?.limit).toBeGreaterThanOrEqual(1);
          expect(requested?.limit).toBeLessThanOrEqual(500);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("rejects malformed terminal-send-sms payloads without calling native send", async () => {
    mockBridge();

    await expect(
      interact("terminal-send-sms", { address: " ", body: "hello" }),
    ).rejects.toThrow("address is required");
    await expect(
      interact("terminal-send-sms", { address: "+15550300", body: "\n\t" }),
    ).rejects.toThrow("body is required");
    await expect(
      interact("terminal-send-sms", {
        address: ["+15550300"] as unknown as string,
        body: { text: "hello" } as unknown as string,
      }),
    ).rejects.toThrow("address is required");

    expect(bridge.sendSms).not.toHaveBeenCalled();
  });
});
