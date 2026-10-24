/**
 * `list-threads` must return the conversation history the native bridge can
 * read. The shared loader clamped every request to the bounded UI page, so this
 * capability refused to answer for any device holding that many messages, even
 * though `ListMessagesOptions` documents that the bridge reads every match.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { listMessages, getStatus, requestRole } = vi.hoisted(() => ({
  listMessages: vi.fn(),
  getStatus: vi.fn(),
  requestRole: vi.fn(),
}));

vi.mock("@elizaos/plugin-native-messages/bridge", () => ({
  Messages: { listMessages },
}));

vi.mock("@elizaos/capacitor-system", () => ({
  System: { getStatus, requestRole },
}));

import type { SmsMessageSummary } from "../definitions.ts";
import { interact } from "./messages-interact.ts";

const COMPLETE_READ_LIMIT = 2_147_483_647;

function messages(count: number): SmsMessageSummary[] {
  return Array.from({ length: count }, (_value, index) => ({
    id: String(index + 1),
    threadId: index % 2 === 0 ? "thread-a" : "thread-b",
    address: index % 2 === 0 ? "+15550100" : "+15550200",
    body: `message ${index + 1}`,
    date: 1_700_000_000_000 + index,
    type: 1,
    read: true,
  }));
}

describe("messages list-threads capability", () => {
  beforeEach(() => {
    listMessages.mockReset();
    getStatus.mockReset().mockResolvedValue({
      roles: [{ role: "sms", held: true, holders: ["eliza"] }],
    });
    requestRole.mockReset().mockResolvedValue({});
  });

  it("asks the bridge for the complete history instead of the bounded UI page", async () => {
    listMessages.mockResolvedValue({ messages: messages(600) });

    const result = (await interact("list-threads")) as {
      threads: { id: string; messageCount: number }[];
    };

    expect(listMessages).toHaveBeenCalledWith({ limit: COMPLETE_READ_LIMIT });
    expect(result.threads).toHaveLength(2);
    expect(result.threads[0].messageCount).toBe(300);
  });

  it("lists every thread on a device that holds five hundred messages", async () => {
    listMessages.mockResolvedValue({ messages: messages(500) });

    await expect(interact("list-threads")).resolves.toMatchObject({
      ownsSmsRole: true,
      smsRoleHolder: "eliza",
    });
    expect(listMessages).toHaveBeenCalledWith({ limit: COMPLETE_READ_LIMIT });
  });

  it("keeps the role-request read bounded to the UI page", async () => {
    listMessages.mockResolvedValue({ messages: messages(3) });

    await interact("request-sms-role");

    expect(listMessages).toHaveBeenCalledWith({ limit: 200 });
  });
});
