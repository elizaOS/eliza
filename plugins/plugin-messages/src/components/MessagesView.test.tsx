// @vitest-environment jsdom

/**
 * Drives the unified MessagesView (the single GUI/XR data wrapper) through the
 * rendered DOM — the same component the bundle exports for both the "gui" and
 * "xr" modalities. Asserts the thread list, open-thread, compose address/body,
 * send, refresh, the SMS-role request, and the error/permission path all reach
 * the native bridge with the exact arguments.
 */

import {
  cleanup,
  configure,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

configure({ asyncUtilTimeout: 5000 });

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

import { __setNavigateViewPayloadForTests } from "@elizaos/ui/app-navigate-view";
import { MessagesView } from "./MessagesView";

// Real-shaped SmsMessageSummary rows. type 1 = inbound, 2 = sent.
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

function button(agentId: string): HTMLButtonElement {
  const el = document.querySelector(`[data-agent-id="${agentId}"]`);
  if (!el) throw new Error(`no element with data-agent-id="${agentId}"`);
  return el as HTMLButtonElement;
}

function field(agentId: string): HTMLElement {
  const el = document.querySelector(`[data-agent-id="${agentId}"]`);
  if (!el) throw new Error(`no element with data-agent-id="${agentId}"`);
  return el as HTMLElement;
}

beforeEach(() => {
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
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("MessagesView — unified GUI/XR thread list", () => {
  it("loads both threads on mount with addresses and last-message previews", async () => {
    render(React.createElement(MessagesView));
    await screen.findByText("+15550200");
    expect(bridge.listMessages).toHaveBeenCalledWith({ limit: 200 });
    expect(screen.getByText("+15550100")).toBeTruthy();
    expect(screen.getByText("newer message")).toBeTruthy();
    expect(screen.getByText("reply to alice")).toBeTruthy();
    // thread-a has one unread inbound -> the badge renders "1".
    expect(screen.getByText("1")).toBeTruthy();
  });

  it("shows the compact empty line when the inbox is empty", async () => {
    bridge.listMessages.mockResolvedValue({ messages: [] });
    render(React.createElement(MessagesView));
    await screen.findByText("None");
  });
});

describe("MessagesView — compose and send", () => {
  it("prefills the composer from a generic navigation payload", async () => {
    __setNavigateViewPayloadForTests("messages", {
      recipient: " +15550400 ",
    });

    render(React.createElement(MessagesView));
    await screen.findByText("+15550200");

    expect((field("compose-address") as HTMLInputElement).value).toBe(
      "+15550400",
    );
  });

  it("composes an address + body and sends the trimmed SMS via the bridge", async () => {
    render(React.createElement(MessagesView));
    await screen.findByText("+15550200");

    fireEvent.change(field("compose-address"), {
      target: { value: " +15550400 " },
    });
    fireEvent.change(field("compose-body"), {
      target: { value: " hello from spatial " },
    });
    fireEvent.click(button("send"));

    await waitFor(() =>
      expect(bridge.sendSms).toHaveBeenCalledWith({
        address: "+15550400",
        body: "hello from spatial",
      }),
    );
  });

  it("disables send and never calls the bridge when the body is blank", async () => {
    render(React.createElement(MessagesView));
    await screen.findByText("+15550200");

    fireEvent.change(field("compose-address"), {
      target: { value: "+15550400" },
    });
    fireEvent.change(field("compose-body"), { target: { value: "  \n\t " } });

    expect(button("send").disabled).toBe(true);
    fireEvent.click(button("send"));
    expect(bridge.sendSms).not.toHaveBeenCalled();
  });

  it("prefills the composer address when a recent thread's Open is clicked", async () => {
    render(React.createElement(MessagesView));
    await screen.findByText("+15550100");

    fireEvent.click(button("open-thread-thread-a"));

    await waitFor(() =>
      expect((field("compose-address") as HTMLInputElement).value).toBe(
        "+15550100",
      ),
    );
    // Opening a thread renders its message log (last messages in/out).
    expect(screen.getAllByText("hello from alice").length).toBeGreaterThan(0);
  });
});

describe("MessagesView — SMS role + refresh", () => {
  it("renders the request-sms-role control when unclaimed and wires it to the bridge", async () => {
    bridge.getStatus
      .mockResolvedValueOnce(statusWith(false))
      .mockResolvedValueOnce(statusWith(true));

    render(React.createElement(MessagesView));
    await screen.findByText("+15550200");

    fireEvent.click(button("request-sms-role"));
    await waitFor(() =>
      expect(bridge.requestRole).toHaveBeenCalledWith({ role: "sms" }),
    );
    // After the role is held, the request control disappears.
    await waitFor(() =>
      expect(
        document.querySelector('[data-agent-id="request-sms-role"]'),
      ).toBeNull(),
    );
  });

  it("hides the request-sms-role control when the role is already held", async () => {
    bridge.getStatus.mockResolvedValue(statusWith(true));
    render(React.createElement(MessagesView));
    await screen.findByText("+15550200");
    expect(
      document.querySelector('[data-agent-id="request-sms-role"]'),
    ).toBeNull();
  });

  it("refresh re-loads messages and status from the bridge", async () => {
    render(React.createElement(MessagesView));
    await screen.findByText("+15550200");
    expect(bridge.listMessages).toHaveBeenCalledTimes(1);

    fireEvent.click(button("refresh"));
    await waitFor(() => expect(bridge.listMessages).toHaveBeenCalledTimes(2));
    expect(bridge.getStatus).toHaveBeenCalledTimes(2);
  });
});

describe("MessagesView — error + permission path", () => {
  it("renders the error text when the inbox fetch rejects", async () => {
    bridge.listMessages.mockRejectedValue(new Error("SMS read failed"));
    render(React.createElement(MessagesView));
    await screen.findByText("SMS read failed");
  });

  it("surfaces the permission message when SMS access is not granted", async () => {
    bridge.requestPermissions.mockResolvedValue({ sms: "denied" });
    render(React.createElement(MessagesView));
    await screen.findByText(/SMS access is needed/);
    expect(bridge.listMessages).not.toHaveBeenCalled();
  });
});
