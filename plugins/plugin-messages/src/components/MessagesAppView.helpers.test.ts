import type { SmsMessageSummary } from "@elizaos/capacitor-messages";
import type { SystemStatus } from "@elizaos/capacitor-system";
import { describe, expect, it } from "vitest";
import {
  buildThreads,
  normalizeMessagesLimit,
  smsRole,
} from "./MessagesAppView.helpers";

// Shape verified against the real provider types in
// plugins/plugin-native-messages/src/definitions.ts (SmsMessageSummary) and
// plugins/plugin-native-system/src/definitions.ts (SystemStatus / AndroidRoleStatus).
// type 1 = inbound (received), type 2 = outbound (sent) — matches Android SMS_TYPE.
function msg(overrides: Partial<SmsMessageSummary>): SmsMessageSummary {
  return {
    id: "id",
    threadId: "thread",
    address: "+15550100",
    body: "body",
    date: 1_700_000_000_000,
    type: 1,
    read: true,
    ...overrides,
  };
}

describe("buildThreads", () => {
  it("groups messages by threadId, sorts threads newest-first and messages oldest-first", () => {
    const messages: SmsMessageSummary[] = [
      msg({
        id: "a1",
        threadId: "t-a",
        address: "+15550100",
        body: "first to alice",
        date: 1_000,
        type: 1,
        read: true,
      }),
      msg({
        id: "a2",
        threadId: "t-a",
        address: "+15550100",
        body: "alice reply",
        date: 3_000,
        type: 2,
        read: true,
      }),
      msg({
        id: "b1",
        threadId: "t-b",
        address: "+15550200",
        body: "bob says hi",
        date: 5_000,
        type: 1,
        read: true,
      }),
    ];

    const threads = buildThreads(messages);

    // Two distinct threads, newest last-message first (t-b @ 5000 before t-a @ 3000).
    expect(threads.map((thread) => thread.id)).toEqual(["t-b", "t-a"]);
    expect(threads[0].address).toBe("+15550200");
    expect(threads[0].lastMessage.body).toBe("bob says hi");

    // Messages inside a thread are ascending by date.
    const alice = threads[1];
    expect(alice.messages.map((m) => m.id)).toEqual(["a1", "a2"]);
    expect(alice.lastMessage.body).toBe("alice reply");
  });

  it("counts only unread inbound (type 1) messages toward unreadCount", () => {
    const messages: SmsMessageSummary[] = [
      msg({ id: "u1", threadId: "t", type: 1, read: false }), // unread inbound -> counts
      msg({ id: "u2", threadId: "t", type: 1, read: false }), // unread inbound -> counts
      msg({ id: "r1", threadId: "t", type: 1, read: true }), // read inbound -> no
      msg({ id: "o1", threadId: "t", type: 2, read: false }), // outbound (sent) -> no
    ];

    const [thread] = buildThreads(messages);
    expect(thread.unreadCount).toBe(2);
  });

  it("falls back to address then id when threadId is empty for grouping", () => {
    const messages: SmsMessageSummary[] = [
      msg({ id: "x1", threadId: "", address: "+15550300", date: 10 }),
      msg({ id: "x2", threadId: "", address: "+15550300", date: 20 }),
      msg({ id: "lonely", threadId: "", address: "", date: 30 }),
    ];

    const threads = buildThreads(messages);
    // Two address-grouped (+15550300) collapse into one thread keyed by address;
    // the empty-address message keys by its own id.
    const grouped = threads.find((thread) => thread.id === "+15550300");
    const byId = threads.find((thread) => thread.id === "lonely");
    expect(grouped?.messages.map((m) => m.id)).toEqual(["x1", "x2"]);
    expect(byId).toBeTruthy();
    expect(threads).toHaveLength(2);
  });
});

describe("smsRole", () => {
  it("extracts the sms role from a real-shaped SystemStatus", () => {
    const status: SystemStatus = {
      packageName: "ai.eliza",
      roles: [
        {
          role: "dialer",
          androidRole: "android.app.role.DIALER",
          held: true,
          holders: ["com.android.dialer"],
          available: true,
        },
        {
          role: "sms",
          androidRole: "android.app.role.SMS",
          held: false,
          holders: ["com.android.messages"],
          available: true,
        },
      ],
    };
    const role = smsRole(status);
    expect(role?.role).toBe("sms");
    expect(role?.held).toBe(false);
    expect(role?.holders[0]).toBe("com.android.messages");
  });

  it("returns null for a null status or a status with no sms role", () => {
    expect(smsRole(null)).toBeNull();
    expect(smsRole({ packageName: "web", roles: [] })).toBeNull();
  });
});

describe("normalizeMessagesLimit", () => {
  it("clamps to [1,500] and truncates fractional values", () => {
    expect(normalizeMessagesLimit(50)).toBe(50);
    expect(normalizeMessagesLimit(0)).toBe(1);
    expect(normalizeMessagesLimit(-10)).toBe(1);
    expect(normalizeMessagesLimit(9999)).toBe(500);
    expect(normalizeMessagesLimit(25.9)).toBe(25);
  });

  it("falls back to the default for non-finite / non-number input", () => {
    expect(normalizeMessagesLimit(undefined)).toBe(200);
    expect(normalizeMessagesLimit(Number.NaN)).toBe(200);
    expect(normalizeMessagesLimit(Number.POSITIVE_INFINITY)).toBe(200);
    expect(normalizeMessagesLimit("100")).toBe(200);
    expect(normalizeMessagesLimit(50, 10)).toBe(50);
    expect(normalizeMessagesLimit(undefined, 10)).toBe(10);
  });
});
