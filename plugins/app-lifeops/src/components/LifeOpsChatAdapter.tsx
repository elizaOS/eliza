import type {
  LifeOpsActiveReminderView,
  LifeOpsCalendarEvent,
  LifeOpsInboxMessage,
} from "@elizaos/shared";
import { useAppWorkspaceChatChrome, useChatComposer } from "@elizaos/ui";
import { type ReactNode, useCallback, useEffect } from "react";
import {
  type LifeOpsSelection,
  useLifeOpsSelection,
} from "./LifeOpsSelectionContext.js";

export interface PrefillChatDetail {
  text: string;
  select?: boolean;
}

function channelLabel(channel: LifeOpsInboxMessage["channel"]): string {
  switch (channel) {
    case "gmail":
      return "email";
    case "x_dm":
      return "X DM";
    case "discord":
      return "Discord message";
    case "telegram":
      return "Telegram message";
    case "signal":
      return "Signal message";
    case "imessage":
      return "iMessage";
    case "whatsapp":
      return "WhatsApp message";
    case "sms":
      return "text message";
    default:
      return "message";
  }
}

function formatChatDateTime(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return null;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(parsed));
}

export function postToChat(text: string, options?: { select?: boolean }): void {
  window.dispatchEvent(
    new CustomEvent<PrefillChatDetail>("eliza:chat:prefill", {
      detail: { text, select: options?.select ?? false },
    }),
  );
}

export function buildMessageChatPrefill(message: LifeOpsInboxMessage): string {
  const subject = message.subject?.trim() || `${channelLabel(message.channel)}`;
  const receivedAt = formatChatDateTime(message.receivedAt);
  const link = message.deepLink ? ` Source: ${message.deepLink}` : "";
  return [
    `Help me handle this ${channelLabel(message.channel)} from ${message.sender.displayName}.`,
    `Subject: ${subject}.`,
    receivedAt ? `Received: ${receivedAt}.` : null,
    message.snippet?.trim().length
      ? `Context: ${message.snippet.trim()}`
      : null,
    link || null,
  ]
    .filter(Boolean)
    .join(" ");
}

export function buildReminderChatPrefill(
  reminder: LifeOpsActiveReminderView,
): string {
  const scheduledFor = formatChatDateTime(reminder.scheduledFor);
  return [
    `Help me handle this reminder: ${reminder.title}.`,
    scheduledFor ? `Scheduled: ${scheduledFor}.` : null,
    reminder.stepLabel ? `Step: ${reminder.stepLabel}.` : null,
    reminder.channel ? `Delivery: ${reminder.channel}.` : null,
  ]
    .filter(Boolean)
    .join(" ");
}

export function buildEventChatPrefill(event: LifeOpsCalendarEvent): string {
  const startAt = formatChatDateTime(event.startAt);
  const endAt = formatChatDateTime(event.endAt);
  return [
    `Help me with this calendar event: ${event.title}.`,
    startAt ? `Starts: ${startAt}.` : null,
    endAt ? `Ends: ${endAt}.` : null,
    event.location ? `Location: ${event.location}.` : null,
  ]
    .filter(Boolean)
    .join(" ");
}

export function useLifeOpsChatLauncher(): {
  openLifeOpsChat: (
    text: string,
    selection?: Partial<LifeOpsSelection>,
    options?: { select?: boolean },
  ) => void;
  chatAboutMessage: (message: LifeOpsInboxMessage) => void;
  chatAboutReminder: (reminder: LifeOpsActiveReminderView) => void;
  chatAboutEvent: (event: LifeOpsCalendarEvent) => void;
} {
  const { select } = useLifeOpsSelection();
  const chatChrome = useAppWorkspaceChatChrome();

  const openLifeOpsChat = useCallback(
    (
      text: string,
      selection?: Partial<LifeOpsSelection>,
      options?: { select?: boolean },
    ) => {
      select(selection ?? {});
      chatChrome?.openChat();
      if (typeof window === "undefined") {
        postToChat(text, options);
        return;
      }
      window.requestAnimationFrame(() => {
        postToChat(text, options);
      });
    },
    [chatChrome, select],
  );

  const chatAboutMessage = useCallback(
    (message: LifeOpsInboxMessage) => {
      openLifeOpsChat(buildMessageChatPrefill(message), {
        messageId: message.id,
      });
    },
    [openLifeOpsChat],
  );

  const chatAboutReminder = useCallback(
    (reminder: LifeOpsActiveReminderView) => {
      openLifeOpsChat(buildReminderChatPrefill(reminder), {
        reminderId: reminder.ownerId,
        eventId: reminder.eventId ?? null,
      });
    },
    [openLifeOpsChat],
  );

  const chatAboutEvent = useCallback(
    (event: LifeOpsCalendarEvent) => {
      openLifeOpsChat(buildEventChatPrefill(event), {
        eventId: event.id,
      });
    },
    [openLifeOpsChat],
  );

  return {
    openLifeOpsChat,
    chatAboutMessage,
    chatAboutReminder,
    chatAboutEvent,
  };
}

export function useLifeOpsChatAdapter(selection: LifeOpsSelection): {
  placeholder: string | null;
} {
  const { setChatInput } = useChatComposer();

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<PrefillChatDetail>).detail;
      if (!detail?.text) {
        return;
      }
      setChatInput(detail.text);
      window.requestAnimationFrame(() => {
        const ta = document.querySelector<HTMLTextAreaElement>(
          "[data-chat-composer-textarea]",
        );
        if (!ta) return;
        ta.focus();
        if (detail.select) {
          ta.select();
        }
      });
    };

    window.addEventListener("eliza:chat:prefill", handler);
    return () => {
      window.removeEventListener("eliza:chat:prefill", handler);
    };
  }, [setChatInput]);

  useEffect(() => {
    if (!selection.reminderId && !selection.eventId && !selection.messageId) {
      setChatInput("");
    }
  }, [
    selection.eventId,
    selection.messageId,
    selection.reminderId,
    setChatInput,
  ]);

  let placeholder: string | null = null;
  if (selection.reminderId) {
    placeholder = "Ask about this reminder…";
  } else if (selection.eventId) {
    placeholder = "Ask about this event…";
  } else if (selection.messageId) {
    placeholder = "Ask about this message…";
  }

  return { placeholder };
}

export function LifeOpsChatAdapter({ children }: { children: ReactNode }) {
  const { selection } = useLifeOpsSelection();
  const { placeholder } = useLifeOpsChatAdapter(selection);

  return (
    <div
      className="relative flex h-full flex-col"
      data-testid="lifeops-chat-adapter"
    >
      {placeholder ? (
        <div className="shrink-0 border-b border-border/12 bg-bg/60 px-4 py-1.5">
          <span className="text-xs text-muted">{placeholder}</span>
        </div>
      ) : null}
      <div className="flex min-h-0 flex-1 flex-col">{children}</div>
    </div>
  );
}

export function buildReplyPrefill(opts: {
  channel: string;
  sender: string;
  snippet: string;
  deepLink?: string | null;
}): string {
  const link = opts.deepLink ? ` — ${opts.deepLink}` : "";
  return `Please draft a reply to this ${opts.channel} message from ${opts.sender}: ${opts.snippet}${link}`;
}
