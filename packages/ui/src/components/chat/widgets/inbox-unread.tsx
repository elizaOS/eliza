/**
 * Icon-first home widget surfacing the highest-priority unread inbox thread
 * (sender + subject, with a count badge), tapping opens the Inbox view. One of
 * the home-attention widget family; publishes into the shared home-attention
 * store so it ranks itself on the home surface. Polls only while authenticated
 * and the document is visible.
 */
import { Inbox } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { client } from "../../../api";
import { supportsFullAppShellRoutes } from "../../../api/app-shell-capabilities";
import { useIntervalWhenDocumentVisible } from "../../../hooks";
import { useIsAuthenticated } from "../../../hooks/useAuthStatus";
import { usePublishHomeAttention } from "../../../widgets/home-attention-store";
import { HOME_SIGNAL_WEIGHTS } from "../../../widgets/home-priority";
import type { WidgetProps } from "../../../widgets/types";
import { HomeWidgetCard, useWidgetNavigation } from "./home-widget-card";

// Compact, icon-first home card for the cross-channel inbox: the ONE unread
// thread that most needs a reply. Same data source the full InboxView owns —
// GET {base}/api/lifeops/inbox (served by the personal-assistant routes) —
// parsed by the same wire shape (LifeOpsInboxMessage in
// packages/shared/src/contracts/personal-assistant.ts). Renders null when
// nothing is unread, and self-publishes a `message`-weight home signal while
// unread threads exist so the card floats up over quiet widgets.

const INBOX_WIDGET_KEY = "inbox/inbox.unread";
const INBOX_REFRESH_INTERVAL_MS = 20_000; // matches InboxView's INBOX_POLL_MS

interface UnreadThread {
  id: string;
  sender: string;
  subject: string;
  /** Coarse importance bucket from the PA priority scorer. */
  important: boolean;
  /** 0–100 priority score; higher = surfaces first. */
  priorityScore: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Extract unread threads from the `/api/lifeops/inbox` payload (untrusted
 * network input, so narrowed defensively). The wire shape mirrors
 * `LifeOpsInboxMessage`: `{ id, sender: { displayName }, subject, snippet,
 * unread, priorityScore?, priorityCategory? }`. "urgent / needs-reply" maps to
 * the scorer's `important` bucket (category === "important"); there is no
 * literal `classification` on the wire.
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
    const priorityScore =
      typeof message.priorityScore === "number" ? message.priorityScore : 0;
    const important = message.priorityCategory === "important";
    threads.push({ id, sender, subject, important, priorityScore });
  }
  return threads;
}

/**
 * Shallow content equality so an unchanged 20s poll doesn't re-render — only the
 * fields the card renders (count, top thread identity, importance) participate.
 */
function unreadEqual(a: UnreadThread[], b: UnreadThread[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((thread, i) => {
    const other = b[i];
    return (
      thread.id === other.id &&
      thread.sender === other.sender &&
      thread.subject === other.subject &&
      thread.important === other.important &&
      thread.priorityScore === other.priorityScore
    );
  });
}

export function InboxUnreadWidget({
  spanClassName = "col-span-2 row-span-1",
}: Partial<WidgetProps>) {
  const [unread, setUnread] = useState<UnreadThread[]>([]);
  const [loaded, setLoaded] = useState(false);
  const nav = useWidgetNavigation();
  // Auth gate (#11084): the widget mounts before the auth probe resolves, so
  // the 20s inbox poll must stay dormant until the session is authenticated.
  const authenticated = useIsAuthenticated();

  const loadInbox = useCallback(async () => {
    const baseUrl = client.getBaseUrl();
    if (!authenticated || !supportsFullAppShellRoutes(baseUrl)) {
      setLoaded(true);
      setUnread([]);
      return;
    }
    try {
      const response = await fetch(`${baseUrl}/api/lifeops/inbox`);
      if (!response.ok) return;
      const next = parseUnread(await response.json());
      // Skip the state update (and the re-render) when the poll is unchanged.
      setUnread((prev) => (unreadEqual(prev, next) ? prev : next));
    } catch {
      // error-policy:J4 glance tile — keep the last good data on a transient
      // fetch failure; the next tick refreshes.
    } finally {
      setLoaded(true);
    }
  }, [authenticated]);

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

  // The single high-priority datum: the highest-scored unread thread. Computed
  // once per snapshot change so an unchanged poll keeps a stable reference.
  const top = useMemo<UnreadThread | null>(() => {
    if (unread.length === 0) return null;
    return unread.reduce((best, thread) =>
      thread.priorityScore > best.priorityScore ? thread : best,
    );
  }, [unread]);
  const hasImportant = useMemo(
    () => unread.some((thread) => thread.important),
    [unread],
  );

  // Render nothing until the first load resolves with unread threads — the home
  // surface must not show an empty placeholder (#9143).
  if (!loaded || top == null) return null;

  // One datum, icon-first: the top thread's sender (or its subject when the
  // sender is unknown); the unread count is a badge; warn tone when any unread
  // thread is in the scorer's "important" bucket. Tapping opens the Inbox view.
  const datum =
    top.sender !== "Someone" ? top.sender : top.subject || top.sender;
  const tone = hasImportant ? "warn" : "default";
  return (
    <div className={`min-w-0 ${spanClassName}`}>
      <HomeWidgetCard
        icon={<Inbox />}
        label="Inbox"
        value={datum}
        badge={unread.length}
        tone={tone}
        testId="chat-widget-inbox-unread"
        ariaLabel={`Inbox: ${unread.length} unread thread${unread.length === 1 ? "" : "s"} need a reply, top from ${datum}. Open Inbox.`}
        onActivate={() => nav.openView("/inbox", "inbox")}
      />
    </div>
  );
}

export const INBOX_HOME_WIDGET = {
  pluginId: "inbox",
  id: "inbox.unread",
  order: 85,
  signalKinds: ["message", "approval"],
  Component: InboxUnreadWidget,
} as const;
