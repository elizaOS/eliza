import { MessageSquare } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { client } from "../../../api";
import { useIntervalWhenDocumentVisible } from "../../../hooks/useDocumentVisibility";
import type { WidgetProps } from "../../../widgets/types";
import { EmptyWidgetState, WidgetSection } from "./shared";

const MESSAGES_REFRESH_INTERVAL_MS = 20_000;
const MAX_VISIBLE_CHATS = 5;

type InboxChat = Awaited<
  ReturnType<typeof client.getInboxChats>
>["chats"][number];

function relativeTime(ts: number): string {
  const delta = Math.max(0, Date.now() - ts);
  const seconds = Math.floor(delta / 1000);
  if (seconds < 10) return "now";
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export function MessagesWidget(_props: WidgetProps) {
  const [chats, setChats] = useState<InboxChat[]>([]);
  const [loading, setLoading] = useState(true);

  const loadChats = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const result = await client.getInboxChats({});
      setChats(result.chats.slice(0, MAX_VISIBLE_CHATS));
    } catch {
      // Inbox may be unavailable during early boot or in stripped runtimes.
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadChats(false);
  }, [loadChats]);

  useIntervalWhenDocumentVisible(
    () => void loadChats(true),
    MESSAGES_REFRESH_INTERVAL_MS,
  );

  return (
    <WidgetSection
      title="Messages"
      icon={<MessageSquare className="h-4 w-4" />}
      testId="chat-widget-messages"
    >
      {loading && chats.length === 0 ? (
        <div className="py-3 text-xs text-muted">Refreshing messages…</div>
      ) : chats.length === 0 ? (
        <EmptyWidgetState
          icon={<MessageSquare className="h-8 w-8" />}
          title="No recent messages"
        />
      ) : (
        <div className="flex flex-col gap-2">
          {chats.map((chat) => (
            <div
              key={chat.id}
              className="rounded-sm border border-border/50 bg-bg/70 p-3"
            >
              <div className="flex items-center gap-2.5">
                {chat.avatarUrl ? (
                  <img
                    src={chat.avatarUrl}
                    alt=""
                    className="h-7 w-7 shrink-0 rounded-full object-cover"
                  />
                ) : (
                  <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-bg-accent text-[11px] font-semibold text-muted">
                    {chat.title.slice(0, 1).toUpperCase()}
                  </span>
                )}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs font-semibold text-txt">
                    {chat.title}
                  </span>
                  <span className="block truncate text-xs-tight leading-5 text-muted">
                    {chat.lastMessageText}
                  </span>
                </span>
                <span className="shrink-0 text-3xs tabular-nums text-muted">
                  {relativeTime(chat.lastMessageAt)}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </WidgetSection>
  );
}
