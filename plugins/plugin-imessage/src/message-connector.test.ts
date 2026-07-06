/**
 * Covers the iMessage message-connector send registration without touching
 * Messages.app. A stub service captures the outbound body so marker stripping is
 * tested on the same path production connector sends use.
 */

import type { Content, IAgentRuntime, MessageConnectorRegistration, UUID } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";

vi.mock("@elizaos/core", async () => await vi.importActual("@elizaos/core"));

import { IMessageService } from "./service";
import type { IMessageServiceStatus } from "./types";

const connectedStatus: IMessageServiceStatus = {
  available: true,
  connected: true,
  chatDbAvailable: true,
  sendOnly: false,
  chatDbPath: "/tmp/chat.db",
  reason: null,
  permissionAction: null,
};

function makeRuntime(registrations: MessageConnectorRegistration[]): IAgentRuntime {
  return {
    agentId: "agent-1" as UUID,
    getSetting: vi.fn((key: string) => (key === "ELIZA_APP_URL" ? "https://app.test" : undefined)),
    getRoom: vi.fn(async () => null),
    registerMessageConnector: vi.fn((registration: MessageConnectorRegistration) => {
      registrations.push(registration);
    }),
    registerSendHandler: vi.fn(),
  } as unknown as IAgentRuntime;
}

describe("iMessage message connector registration", () => {
  it("strips interaction markers before sending connector replies", async () => {
    const registrations: MessageConnectorRegistration[] = [];
    const sent: Array<{ to: string; text: string }> = [];
    const runtime = makeRuntime(registrations);
    const service = {
      getStatus: vi.fn(() => connectedStatus),
      getContacts: vi.fn(() => new Map()),
      sendMessage: vi.fn(async (to: string, text: string) => {
        sent.push({ to, text });
        return { success: true, messageId: "im-1", chatId: "chat-1" };
      }),
    } as unknown as IMessageService;

    IMessageService.registerSendHandlers(runtime, service);
    const connector = registrations.find((registration) => registration.source === "imessage");

    await connector?.sendHandler?.(runtime, { source: "imessage", channelId: "+14155552671" }, {
      text: "Pick:\n[CHOICE:next id=c1]\ny=Yes\nn=No\n[/CHOICE]",
    } as Content);

    expect(sent).toEqual([
      {
        to: "+14155552671",
        text: "Pick:\n\n1. Yes\n2. No\nReply with a number.",
      },
    ]);
  });
});
