// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import fc from "fast-check";
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

import { MessagesAppView, MessagesTuiView } from "./MessagesAppView";
import { interact } from "./MessagesAppView.interact";

const t = (key: string, opts?: { defaultValue?: string }) =>
  opts?.defaultValue ?? key;

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

function overlayContext(exitToApps = vi.fn()) {
  return {
    exitToApps,
    uiTheme: "light" as const,
    t,
  };
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
    expect(
      JSON.parse(stateElement?.getAttribute("data-view-state") ?? "{}"),
    ).toMatchObject({
      viewType: "tui",
      viewId: "messages",
      messageCount: 3,
      threadCount: 2,
      ownsSmsRole: false,
      smsRoleHolder: "com.android.messages",
    });

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

describe("MessagesAppView", () => {
  it("keeps overlay back navigation inside the composer before exiting apps", async () => {
    mockBridge();
    const exitToApps = vi.fn();

    render(React.createElement(MessagesAppView, overlayContext(exitToApps)));

    fireEvent.click(await screen.findByTestId("messages-thread-thread-a"));
    expect(
      (screen.getByTestId("messages-compose-address") as HTMLInputElement)
        .value,
    ).toBe("+15550100");

    fireEvent.click(screen.getByRole("button", { name: "Back to threads" }));

    expect(exitToApps).not.toHaveBeenCalled();
    expect(screen.getByTestId("messages-thread-list").className).toContain(
      "flex",
    );

    fireEvent.click(screen.getByRole("button", { name: "Back" }));

    expect(exitToApps).toHaveBeenCalledTimes(1);
  });

  it("blocks blank composed SMS bodies and trims outbound addresses and text", async () => {
    mockBridge();

    render(React.createElement(MessagesAppView, overlayContext()));

    await screen.findByText("+15550200");
    fireEvent.click(screen.getByTestId("messages-new"));

    fireEvent.change(screen.getByTestId("messages-compose-address"), {
      target: { value: " +15550400 " },
    });
    fireEvent.change(screen.getByTestId("messages-compose-body"), {
      target: { value: " \n\t " },
    });

    const sendButton = screen.getByTestId("messages-send");
    expect((sendButton as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(sendButton);
    expect(bridge.sendSms).not.toHaveBeenCalled();

    fireEvent.change(screen.getByTestId("messages-compose-body"), {
      target: { value: "  hello from overlay  " },
    });
    expect((sendButton as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(sendButton);

    await waitFor(() =>
      expect(bridge.sendSms).toHaveBeenCalledWith({
        address: "+15550400",
        body: "hello from overlay",
      }),
    );
    expect(await screen.findByText("Message sent.")).toBeTruthy();
    expect(
      (screen.getByTestId("messages-compose-body") as HTMLTextAreaElement)
        .value,
    ).toBe("");
  });
});
