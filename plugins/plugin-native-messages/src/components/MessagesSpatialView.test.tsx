// @vitest-environment jsdom
/**
 * Direction marks in the SMS view. Android keeps the owner's own texts in the
 * sent, outbox, failed and queued boxes; only the inbox holds received ones.
 */

import type { SmsMessageSummary } from "@elizaos/plugin-native-messages/bridge";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  MessagesSpatialView,
  type MessagesThreadSummary,
} from "./MessagesSpatialView.tsx";

// android.provider.Telephony.TextBasedSmsColumns.MESSAGE_TYPE_*
const INBOX = 1;
const SENT = 2;
const OUTBOX = 4;
const FAILED = 5;
const QUEUED = 6;

function sms(id: number, type: number, body: string): SmsMessageSummary {
  return {
    id: String(id),
    threadId: "7",
    address: "+15551234567",
    body,
    date: 1_700_000_000_000 + id * 1_000,
    type,
    read: true,
  };
}

function render(messages: SmsMessageSummary[]): HTMLElement {
  const thread: MessagesThreadSummary = {
    id: "7",
    address: "+15551234567",
    messages,
    lastMessage: messages[messages.length - 1],
    unreadCount: 0,
  };
  const host = document.createElement("div");
  host.innerHTML = renderToStaticMarkup(
    <MessagesSpatialView
      snapshot={{
        threads: [thread],
        selectedThreadId: thread.id,
        composeAddress: "",
        composeBody: "",
        ownsSmsRole: true,
        smsRoleHolder: null,
      }}
    />,
  );
  return host;
}

function texts(host: HTMLElement, body: string): Element[] {
  return [...host.querySelectorAll('[data-spatial-kind="text"]')].filter(
    (element) => element.textContent === body,
  );
}

/** The in/out label beside a message in the open conversation. */
function messageLabel(host: HTMLElement, body: string): string | undefined {
  for (const element of texts(host, body)) {
    const label = element.previousElementSibling?.textContent;
    if (label === "in" || label === "out") return label;
  }
  return undefined;
}

/** The < or > mark on the thread row whose newest message is `body`. */
function threadMark(host: HTMLElement, body: string): string | undefined {
  for (const element of texts(host, body)) {
    const mark = element.parentElement?.previousElementSibling?.textContent;
    if (mark === "<" || mark === ">") return mark;
  }
  return undefined;
}

describe("MessagesSpatialView direction", () => {
  it("labels every box but the inbox as the owner's outgoing text", () => {
    const host = render([
      sms(1, INBOX, "see you at 6"),
      sms(2, SENT, "on my way"),
      sms(3, OUTBOX, "running late"),
      sms(4, FAILED, "call me"),
      sms(5, QUEUED, "parked out front"),
    ]);

    expect({
      inbox: messageLabel(host, "see you at 6"),
      sent: messageLabel(host, "on my way"),
      outbox: messageLabel(host, "running late"),
      failed: messageLabel(host, "call me"),
      queued: messageLabel(host, "parked out front"),
    }).toEqual({
      inbox: "in",
      sent: "out",
      outbox: "out",
      failed: "out",
      queued: "out",
    });
  });

  it("marks a thread whose newest text failed to send as outgoing", () => {
    const host = render([sms(1, INBOX, "see you at 6"), sms(2, FAILED, "ok")]);

    expect(threadMark(host, "ok")).toBe(">");
  });

  it("marks a thread whose newest text was received as incoming", () => {
    const host = render([sms(1, SENT, "on my way"), sms(2, INBOX, "ok")]);

    expect(threadMark(host, "ok")).toBe("<");
  });
});
