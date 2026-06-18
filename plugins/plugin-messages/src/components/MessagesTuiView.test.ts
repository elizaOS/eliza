// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
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

function readState(container: HTMLElement) {
  const el = container.querySelector("[data-view-state]");
  return JSON.parse(el?.getAttribute("data-view-state") ?? "{}");
}

describe("MessagesTuiView — interactive controls", () => {
  it("refresh button re-loads state and records lastAction 'refresh'", async () => {
    mockBridge();

    const { container } = render(React.createElement(MessagesTuiView));

    await screen.findByText("+15550200");
    expect(bridge.listMessages).toHaveBeenCalledTimes(1);
    expect(readState(container).lastAction).toBe("refresh");

    fireEvent.click(screen.getByText("refresh"));

    await waitFor(() => expect(bridge.listMessages).toHaveBeenCalledTimes(2));
    expect(bridge.getStatus).toHaveBeenCalledTimes(2);
  });

  it("renders the request-sms-role button when unclaimed and wires it to the bridge", async () => {
    mockBridge();

    const { container } = render(React.createElement(MessagesTuiView));

    const requestButton = await screen.findByText("request sms role");
    expect(requestButton).toBeTruthy();

    fireEvent.click(requestButton);

    await waitFor(() =>
      expect(bridge.requestRole).toHaveBeenCalledWith({ role: "sms" }),
    );
    await waitFor(() =>
      expect(readState(container).lastAction).toBe("request-sms-role"),
    );
  });

  it("hides the request-sms-role button when the role is already held", async () => {
    mockBridge();
    bridge.getStatus.mockResolvedValue({
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
    });

    const { container } = render(React.createElement(MessagesTuiView));

    await screen.findByText("+15550200");
    await waitFor(() => expect(readState(container).ownsSmsRole).toBe(true));
    expect(screen.queryByText("request sms role")).toBeNull();
  });

  it("opening a thread sets lastAction and renders out/in message lines", async () => {
    mockBridge();

    const { container } = render(React.createElement(MessagesTuiView));

    await screen.findByText("+15550100");
    fireEvent.click(screen.getByText("+15550100"));

    await waitFor(() =>
      expect(readState(container).lastAction).toBe("open thread-a"),
    );
    expect(readState(container).selectedThreadId).toBe("thread-a");

    // Selected-thread message log lives in the "SMS compose" region; the body
    // previews also appear in the thread rows, so scope to the compose section.
    const compose = screen.getByRole("region", { name: "SMS compose" });
    expect(within(compose).getByText("in")).toBeTruthy();
    expect(within(compose).getByText("out")).toBeTruthy();
    expect(within(compose).getByText("hello from alice")).toBeTruthy();
    expect(within(compose).getByText("reply to alice")).toBeTruthy();
  });

  it("sends to the opened thread address and clears the body", async () => {
    mockBridge();

    const { container } = render(React.createElement(MessagesTuiView));

    await screen.findByText("+15550100");
    fireEvent.click(screen.getByText("+15550100"));
    fireEvent.change(screen.getByRole("textbox", { name: "body" }), {
      target: { value: "follow up" },
    });
    fireEvent.click(screen.getByText("send"));

    await waitFor(() =>
      expect(bridge.sendSms).toHaveBeenCalledWith({
        address: "+15550100",
        body: "follow up",
      }),
    );
    // send() sets lastAction "sent <addr>" then awaits refresh(), which clears the
    // body and ends with lastAction "refresh" — assert the durable post-send state.
    await waitFor(() => expect(readState(container).composeBodyLength).toBe(0));
    expect(readState(container).lastAction).toBe("refresh");
  });

  it("shows the 'no sms threads' empty line when there are no messages", async () => {
    mockBridge();
    bridge.listMessages.mockResolvedValue({ messages: [] });

    const { container } = render(React.createElement(MessagesTuiView));

    await screen.findByText("no sms threads");
    expect(readState(container).threadCount).toBe(0);
  });

  it("disables send until both address and body are non-blank", async () => {
    mockBridge();

    render(React.createElement(MessagesTuiView));

    await screen.findByText("+15550200");
    const sendButton = screen.getByText("send") as HTMLButtonElement;
    expect(sendButton.disabled).toBe(true);

    // The address input's label text is "to".
    fireEvent.change(screen.getByRole("textbox", { name: "to" }), {
      target: { value: "+15559999" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "body" }), {
      target: { value: "   " },
    });
    expect(sendButton.disabled).toBe(true);

    fireEvent.change(screen.getByRole("textbox", { name: "body" }), {
      target: { value: "ready" },
    });
    expect(sendButton.disabled).toBe(false);
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
