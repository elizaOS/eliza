// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const bridge = vi.hoisted(() => ({
  listMessages: vi.fn(),
  sendSms: vi.fn(),
  getStatus: vi.fn(),
  requestRole: vi.fn(),
}));

vi.mock("@elizaos/capacitor-messages", () => ({
  Messages: {
    listMessages: bridge.listMessages,
    sendSms: bridge.sendSms,
  },
}));

vi.mock("@elizaos/capacitor-system", () => ({
  System: {
    getStatus: bridge.getStatus,
    requestRole: bridge.requestRole,
  },
}));

import { interact, MessagesTuiView } from "./MessagesAppView";

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
  bridge.requestRole.mockResolvedValue({ role: "sms", held: true, resultCode: 0 });
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("MessagesTuiView", () => {
  it("mounts SMS threads, exposes current TUI state, and sends composed messages", async () => {
    mockBridge();

    const { container } = render(React.createElement(MessagesTuiView));

    await screen.findByText("+15550200");
    expect(screen.getByText("newer message")).toBeTruthy();
    expect(screen.getByText("+15550100")).toBeTruthy();
    expect(bridge.listMessages).toHaveBeenCalledWith({ limit: 200 });

    const stateElement = container.querySelector("[data-view-state]");
    expect(JSON.parse(stateElement?.getAttribute("data-view-state") ?? "{}")).toMatchObject(
      {
        viewType: "tui",
        viewId: "messages",
        messageCount: 3,
        threadCount: 2,
        ownsSmsRole: false,
        smsRoleHolder: "com.android.messages",
      },
    );

    fireEvent.click(screen.getByText("+15550100"));
    fireEvent.change(screen.getByRole("textbox", { name: "body" }), {
      target: { value: "terminal reply" },
    });
    fireEvent.click(screen.getByText("send"));

    await waitFor(() =>
      expect(bridge.sendSms).toHaveBeenCalledWith({
        address: "+15550100",
        body: "terminal reply",
      }),
    );
  });

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
});
