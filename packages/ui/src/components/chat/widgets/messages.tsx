import { MessageSquare } from "lucide-react";
import { useMemo } from "react";
import type { Conversation } from "../../../api/client-types-chat";
import { useAppSelector } from "../../../state";
import { formatRelativeTime } from "../../../utils/format";
import type { WidgetProps } from "../../../widgets/types";
import { EmptyWidgetState, WidgetSection } from "./shared";

const MAX_HOME_CONVERSATIONS = 4;

function byUpdatedDesc(a: Conversation, b: Conversation): number {
  return (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "");
}

/**
 * Frontpage Messages widget (#9143). The shared "messages" default widget:
 * recent conversations (title + relative time), so the home surfaces quick
 * access to recent chats. Reads the app store's conversation list directly.
 */
export function MessagesWidget(_props: WidgetProps) {
  const conversations = useAppSelector((s) => s.conversations);
  const recent = useMemo(
    () =>
      [...(conversations ?? [])]
        .sort(byUpdatedDesc)
        .slice(0, MAX_HOME_CONVERSATIONS),
    [conversations],
  );

  return (
    <WidgetSection
      title="Messages"
      icon={<MessageSquare />}
      testId="widget-messages"
    >
      {recent.length === 0 ? (
        <EmptyWidgetState
          icon={<MessageSquare />}
          title="No conversations yet"
          description="Recent chats show up here."
        />
      ) : (
        <ul className="flex flex-col gap-0.5">
          {recent.map((c) => (
            <li
              key={c.id}
              className="flex items-center justify-between gap-2 px-1 py-1"
            >
              <span className="truncate text-xs font-medium text-txt">
                {c.title || "Untitled"}
              </span>
              <span className="shrink-0 text-3xs text-muted">
                {formatRelativeTime(c.updatedAt)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </WidgetSection>
  );
}
