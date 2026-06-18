// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
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

import { MessagesAppView, MessagesPluginView } from "./MessagesAppView";

const t = (key: string, opts?: { defaultValue?: string }) =>
  opts?.defaultValue ?? key;

// Real-shaped SmsMessageSummary rows (see definitions.ts). type 1 = inbound, 2 = sent.
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

function statusWith(held: boolean) {
  return {
    packageName: "ai.eliza",
    roles: [
      {
        role: "sms",
        androidRole: "android.app.role.SMS",
        held,
        holders: ["com.android.messages"],
        available: true,
      },
    ],
  };
}

function mockBridge() {
  bridge.listMessages.mockResolvedValue({ messages: sampleMessages });
  bridge.sendSms.mockResolvedValue({
    messageId: "sent-1",
    messageUri: "content://sms/1",
  });
  bridge.getStatus.mockResolvedValue(statusWith(false));
  bridge.requestRole.mockResolvedValue({
    role: "sms",
    held: true,
    resultCode: 0,
  });
}

function overlayContext(exitToApps = vi.fn()) {
  return { exitToApps, uiTheme: "light" as const, t };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("MessagesAppView — populated thread list", () => {
  it("renders both threads with previews, unread badge, and the stats header", async () => {
    mockBridge();
    render(React.createElement(MessagesAppView, overlayContext()));

    // Both thread rows render with address + last-message preview.
    const threadA = await screen.findByTestId("messages-thread-thread-a");
    const threadB = screen.getByTestId("messages-thread-thread-b");
    expect(within(threadA).getByText("+15550100")).toBeTruthy();
    expect(within(threadA).getByText("reply to alice")).toBeTruthy();
    expect(within(threadB).getByText("+15550200")).toBeTruthy();
    expect(within(threadB).getByText("newer message")).toBeTruthy();

    // thread-a has exactly one unread inbound -> badge "1"; thread-b has none.
    expect(within(threadA).getByText("1")).toBeTruthy();

    // Stats header: 2 threads, 1 unread total.
    expect(screen.getByText("2 threads")).toBeTruthy();
    expect(screen.getByText("1 unread")).toBeTruthy();

    // Header subtitle: role not held -> "Android SMS bridge".
    expect(screen.getByText("Android SMS bridge")).toBeTruthy();
  });

  it("MessagesPluginView wrapper renders the same populated data", async () => {
    mockBridge();
    render(React.createElement(MessagesPluginView));

    expect(await screen.findByTestId("messages-thread-thread-a")).toBeTruthy();
    expect(screen.getByText("2 threads")).toBeTruthy();
    expect(screen.getByText("newer message")).toBeTruthy();
  });
});

describe("MessagesAppView — opening a thread shows message bubbles", () => {
  it("renders sent vs received bubbles in date order with correct alignment", async () => {
    mockBridge();
    render(React.createElement(MessagesAppView, overlayContext()));

    fireEvent.click(await screen.findByTestId("messages-thread-thread-a"));

    // Composer prefilled with the thread address.
    expect(
      (screen.getByTestId("messages-compose-address") as HTMLInputElement)
        .value,
    ).toBe("+15550100");

    // Bubbles render inside the composer panel ("reply to alice" also appears in
    // the thread-row preview, so scope the query to the composer panel).
    const panel = screen.getByTestId("messages-composer-panel");
    const received = within(panel).getByText("hello from alice");
    const sent = within(panel).getByText("reply to alice");
    expect(received).toBeTruthy();
    expect(sent).toBeTruthy();

    // Alignment wrapper: received (type 1) justify-start, sent (type 2) justify-end.
    const receivedWrapper = received.closest("div.flex");
    const sentWrapper = sent.closest("div.flex");
    expect(receivedWrapper?.className).toContain("justify-start");
    expect(sentWrapper?.className).toContain("justify-end");

    // Date order: received (older) appears before sent (newer) in the DOM.
    const bodyText = panel.textContent ?? "";
    expect(bodyText.indexOf("hello from alice")).toBeLessThan(
      bodyText.indexOf("reply to alice"),
    );
  });
});

describe("MessagesAppView — refresh control", () => {
  it("re-invokes listMessages and getStatus and disables while loading", async () => {
    mockBridge();
    render(React.createElement(MessagesAppView, overlayContext()));

    await screen.findByTestId("messages-thread-thread-a");
    expect(bridge.listMessages).toHaveBeenCalledTimes(1);
    expect(bridge.getStatus).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId("messages-refresh"));

    await waitFor(() => expect(bridge.listMessages).toHaveBeenCalledTimes(2));
    expect(bridge.getStatus).toHaveBeenCalledTimes(2);
    expect(bridge.listMessages).toHaveBeenLastCalledWith({ limit: 200 });
  });

  it("disables the refresh button while a load is in flight", async () => {
    // Defer the first load so we can observe the disabled state.
    let release!: () => void;
    const pending = new Promise<{ messages: typeof sampleMessages }>(
      (resolve) => {
        release = () => resolve({ messages: sampleMessages });
      },
    );
    bridge.listMessages.mockReturnValueOnce(pending);
    bridge.getStatus.mockResolvedValue(statusWith(false));

    render(React.createElement(MessagesAppView, overlayContext()));

    const refreshButton = screen.getByTestId(
      "messages-refresh",
    ) as HTMLButtonElement;
    expect(refreshButton.disabled).toBe(true);

    release();
    await waitFor(() => expect(refreshButton.disabled).toBe(false));
  });
});

describe("MessagesAppView — SMS role banner", () => {
  it("shows the banner + bridge subtitle when role is not held, requests on click", async () => {
    mockBridge();
    // After requestRole, getStatus reports the role as now held.
    bridge.getStatus
      .mockResolvedValueOnce(statusWith(false))
      .mockResolvedValueOnce(statusWith(true));

    render(React.createElement(MessagesAppView, overlayContext()));

    await screen.findByTestId("messages-thread-thread-a");
    expect(screen.getByText("Android SMS bridge")).toBeTruthy();
    const bannerButton = screen.getByTestId("messages-request-sms-role");
    expect(bannerButton).toBeTruthy();

    fireEvent.click(bannerButton);

    await waitFor(() =>
      expect(bridge.requestRole).toHaveBeenCalledWith({ role: "sms" }),
    );
    // requestSmsRole re-fetches status after requesting.
    await waitFor(() => expect(bridge.getStatus).toHaveBeenCalledTimes(2));

    // Now role held -> banner gone, subtitle flips to "Default SMS app".
    await waitFor(() =>
      expect(screen.queryByTestId("messages-request-sms-role")).toBeNull(),
    );
    expect(screen.getByText("Default SMS app")).toBeTruthy();
  });

  it("hides the banner when the role is already held", async () => {
    mockBridge();
    bridge.getStatus.mockResolvedValue(statusWith(true));

    render(React.createElement(MessagesAppView, overlayContext()));

    await screen.findByTestId("messages-thread-thread-a");
    expect(screen.queryByTestId("messages-request-sms-role")).toBeNull();
    expect(screen.getByText("Default SMS app")).toBeTruthy();
  });
});

describe("MessagesAppView — empty state", () => {
  it("renders the empty state and opens a blank composer from it", async () => {
    mockBridge();
    bridge.listMessages.mockResolvedValue({ messages: [] });

    render(React.createElement(MessagesAppView, overlayContext()));

    expect(await screen.findByText("No messages yet")).toBeTruthy();
    // Empty-state stat chips: "0 threads" + the bridge mode chip (the bridge
    // label also appears as the header subtitle, hence getAllByText).
    expect(screen.getByText("0 threads")).toBeTruthy();
    expect(screen.getAllByText("Android SMS bridge").length).toBeGreaterThan(0);

    // The empty-state "New message" button is registered via useAgentElement,
    // which stamps data-agent-id (not data-testid).
    const emptyNew = document.querySelector(
      '[data-agent-id="action-empty-new-message"]',
    );
    expect(emptyNew).toBeTruthy();
    fireEvent.click(emptyNew as Element);

    // Composer opens blank.
    expect(
      (screen.getByTestId("messages-compose-address") as HTMLInputElement)
        .value,
    ).toBe("");
    expect(screen.getByTestId("messages-composer-panel").className).toContain(
      "flex",
    );
  });
});

describe("MessagesAppView — error path", () => {
  it("surfaces a listMessages rejection as a role=alert strip with empty thread list", async () => {
    bridge.listMessages.mockRejectedValue(new Error("SMS read failed"));
    bridge.getStatus.mockResolvedValue(statusWith(false));

    render(React.createElement(MessagesAppView, overlayContext()));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("SMS read failed");
    expect(screen.queryByTestId("messages-thread-thread-a")).toBeNull();
  });
});
