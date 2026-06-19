// EXTERNAL-API CONTRACT TEST — exercises the REAL native bridge web layer and the
// REAL parser pipeline (buildThreads / smsRole) WITHOUT vi.mock. The vitest config
// aliases @elizaos/capacitor-messages -> plugin-native-messages/src and
// @elizaos/capacitor-system -> plugin-native-system/src, so the imports below resolve
// to the actual provider sources, and registerPlugin() falls back to MessagesWeb /
// SystemWeb in this (non-Android) environment.
//
// The provider's current API shape (verified against
// plugins/plugin-native-messages/src/definitions.ts and
// plugins/plugin-native-system/src/definitions.ts):
//   SmsMessageSummary = { id, threadId, address, body, date, type, read }
//   SystemStatus = { packageName, roles: AndroidRoleStatus[] }
//   AndroidRoleStatus = { role, androidRole, held, holders, available }
//   type 1 = inbound (received), type 2 = outbound (sent)

import type { SmsMessageSummary } from "@elizaos/capacitor-messages";
import { Messages } from "@elizaos/capacitor-messages";
import type { SystemStatus } from "@elizaos/capacitor-system";
import { System } from "@elizaos/capacitor-system";
import { describe, expect, it } from "vitest";
import {
  buildThreads,
  loadMessagesState,
  smsRole,
} from "./MessagesAppView.helpers";

describe("real bridge web fallback contract", () => {
  it("loadMessagesState yields a contract-valid DTO over the real web layer", async () => {
    // Real MessagesWeb.listMessages -> { messages: [] }; real SystemWeb.getStatus ->
    // { packageName: "web", roles: [] }. No mocks: this drives the actual bridge.
    const state = await loadMessagesState(200);

    expect(state).toEqual({
      messages: [],
      threads: [],
      systemStatus: { packageName: "web", roles: [] },
      ownsSmsRole: false,
      smsRoleHolder: null,
    });
  });

  it("the real Messages/System singletons resolve to the web fallback shape", async () => {
    await expect(Messages.listMessages({ limit: 200 })).resolves.toEqual({
      messages: [],
    });
    const status = await System.getStatus();
    expect(status.packageName).toBe("web");
    expect(status.roles).toEqual([]);
  });

  it("real Messages.sendSms enforces the address/body contract the views rely on", async () => {
    await expect(
      Messages.sendSms({ address: " ", body: "hello" }),
    ).rejects.toThrow("address is required");
    await expect(
      Messages.sendSms({ address: "+15550100", body: "\n\t" }),
    ).rejects.toThrow("body is required");
    // Well-formed payload passes validation, then hits the Android-only guard —
    // proving validation runs first, exactly as interact()/the views assume.
    await expect(
      Messages.sendSms({ address: "+15550100", body: "hello" }),
    ).rejects.toThrow("SMS is only available on Android.");
  });

  it("real System.requestRole matches the typed Android-only contract", async () => {
    await expect(System.requestRole({ role: "sms" })).rejects.toThrow(
      "Android role sms is only available on Android.",
    );
  });
});

describe("parser over a real-shaped provider payload", () => {
  // A realistic MessagesWeb.listMessages() result would carry rows in this exact
  // shape on Android (it is empty on web). We assert the parser produces the
  // ThreadSummary[] / role DTO the views and interact() consume.
  const realShaped: SmsMessageSummary[] = [
    {
      id: "1001",
      threadId: "42",
      address: "+15551234567",
      body: "Hey, are we still on for lunch?",
      date: 1_705_000_000_000,
      type: 1,
      read: false,
    },
    {
      id: "1002",
      threadId: "42",
      address: "+15551234567",
      body: "Yes! See you at noon.",
      date: 1_705_000_060_000,
      type: 2,
      read: true,
    },
    {
      id: "2001",
      threadId: "7",
      address: "+15559876543",
      body: "Your package has shipped.",
      date: 1_705_100_000_000,
      type: 1,
      read: false,
    },
  ];

  const realStatus: SystemStatus = {
    packageName: "ai.eliza",
    roles: [
      {
        role: "sms",
        androidRole: "android.app.role.SMS",
        held: true,
        holders: ["ai.eliza"],
        available: true,
      },
    ],
  };

  it("derives the expected ThreadSummary[] from the provider shape", () => {
    const threads = buildThreads(realShaped);

    // Newest last-message first: shipping thread (date 1_705_100_000_000) before
    // the lunch thread (1_705_000_060_000).
    expect(threads.map((thread) => thread.id)).toEqual(["7", "42"]);

    const lunch = threads.find((thread) => thread.id === "42");
    expect(lunch?.address).toBe("+15551234567");
    expect(lunch?.messages).toHaveLength(2);
    expect(lunch?.lastMessage.body).toBe("Yes! See you at noon.");
    expect(lunch?.unreadCount).toBe(1); // only the unread inbound counts

    const shipping = threads.find((thread) => thread.id === "7");
    expect(shipping?.unreadCount).toBe(1);
    expect(shipping?.lastMessage.body).toBe("Your package has shipped.");
  });

  it("extracts ownsSmsRole / smsRoleHolder from the provider status shape", () => {
    const role = smsRole(realStatus);
    expect(role?.held).toBe(true);
    expect(role?.holders[0]).toBe("ai.eliza");
  });
});
