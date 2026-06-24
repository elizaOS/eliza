import { Inbox } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { client } from "../../../api";
import { useIntervalWhenDocumentVisible } from "../../../hooks";
import { usePublishHomeAttention } from "../../../widgets/home-attention-store";
import { HOME_SIGNAL_WEIGHTS } from "../../../widgets/home-priority";
import type { WidgetProps } from "../../../widgets/types";
import { WidgetSection } from "./shared";

// Compact home card for the cross-channel inbox: the unread threads that still
// need a reply. Same data source the full InboxView owns —
// GET {base}/api/lifeops/inbox (served by the personal-assistant routes) —
// parsed by the same wire shape (InboxWire / InboxMessageWire in
// plugins/plugin-inbox/src/components/inbox/InboxView.tsx). Renders null when
// nothing is unread, and self-publishes a `message`-weight home signal while
// unread threads exist so the card floats up over quiet widgets.

const INBOX_WIDGET_KEY = "inbox/inbox.unread";
const INBOX_REFRESH_INTERVAL_MS = 20_000; // matches InboxView's INBOX_POLL_MS
const MAX_VISIBLE_UNREAD = 4;

interface UnreadThread {
  id: string;
  sender: string;
  summary: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Extract unread threads from the `/api/lifeops/inbox` payload. The wire shape
 * is `{ messages: { id, sender: { displayName }, subject, snippet, unread } }`
 * — validated defensively because it's untrusted network input.
 */
function parseUnread(payload: unknown): UnreadThread[] {
  if (!isRecord(payload) || !Array.isArray(payload.messages)) return [];
  const threads: UnreadThread[] = [];
  for (const message of payload.messages) {
    if (!isRecord(message)) continue;
    if (message.unread !== true) continue;
    const id = typeof message.id === "string" ? message.id : null;
    if (!id) continue;
    const sender =
      isRecord(message.sender) && typeof message.sender.displayName === "string"
        ? message.sender.displayName
        : "Someone";
    const subject = typeof message.subject === "string" ? message.subject : "";
    const snippet = typeof message.snippet === "string" ? message.snippet : "";
    threads.push({ id, sender, summary: subject || snippet });
  }
  return threads;
}

function UnreadRow({ thread }: { thread: UnreadThread }) {
  return (
    <li className="flex flex-col gap-0.5 px-1 py-1">
      <span className="truncate text-xs font-medium text-txt">
        {thread.sender}
      </span>
      {thread.summary ? (
        <span className="truncate text-2xs text-muted">{thread.summary}</span>
      ) : null}
    </li>
  );
}

export function InboxUnreadWidget(_props: Partial<WidgetProps>) {
  const [unread, setUnread] = useState<UnreadThread[]>([]);
  const [loaded, setLoaded] = useState(false);

  const loadInbox = useCallback(async () => {
    try {
      const response = await fetch(`${client.getBaseUrl()}/api/lifeops/inbox`);
      if (!response.ok) return;
      setUnread(parseUnread(await response.json()));
    } catch {
      // Best-effort: keep the last good data on a transient fetch failure.
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void loadInbox();
  }, [loadInbox]);
  useIntervalWhenDocumentVisible(
    () => void loadInbox(),
    INBOX_REFRESH_INTERVAL_MS,
  );

  // Unread threads need a reply — float the card up at `message` weight while
  // any exist; clear otherwise.
  usePublishHomeAttention(
    INBOX_WIDGET_KEY,
    unread.length > 0 ? HOME_SIGNAL_WEIGHTS.message : null,
  );

  // Render nothing until the first load resolves with unread threads — the home
  // surface must not show an empty placeholder (#9143).
  if (!loaded || unread.length === 0) return null;

  const visible = unread.slice(0, MAX_VISIBLE_UNREAD);
  const overflow = unread.length - visible.length;

  return (
    <WidgetSection
      title="Inbox"
      icon={<Inbox className="h-4 w-4" />}
      testId="chat-widget-inbox-unread"
      action={
        <span className="rounded-full bg-accent-subtle px-1.5 text-2xs font-medium text-accent">
          {unread.length}
        </span>
      }
    >
      <ul className="flex flex-col gap-0.5">
        {visible.map((thread) => (
          <UnreadRow key={thread.id} thread={thread} />
        ))}
      </ul>
      {overflow > 0 ? (
        <p className="px-1 text-xs-tight text-muted">
          +{overflow} more unread thread{overflow === 1 ? "" : "s"}
        </p>
      ) : null}
    </WidgetSection>
  );
}

export const INBOX_HOME_WIDGET = {
  pluginId: "inbox",
  id: "inbox.unread",
  order: 85,
  signalKinds: ["message", "approval"],
  Component: InboxUnreadWidget,
} as const;
