import { MessageSquare } from "lucide-react";
import { useMemo } from "react";
import type { Conversation } from "../../../api/client-types-chat";
import { useAppSelector } from "../../../state";
import { formatRelativeTime } from "../../../utils/format";
import type { WidgetProps } from "../../../widgets/types";
import { HomeWidgetCard, useWidgetNavigation } from "./home-widget-card";
import { WidgetSection } from "./shared";

const MAX_HOME_CONVERSATIONS = 4;

function byUpdatedDesc(a: Conversation, b: Conversation): number {
  return (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "");
}

/**
 * Frontpage Messages widget (#9143). The shared "messages" default widget:
 * recent conversations (title + relative time), so the home surfaces quick
 * access to recent chats. Reads the app store's conversation list directly.
 */
export function MessagesWidget(props: WidgetProps) {
  const conversations = useAppSelector((s) => s.conversations);
  const nav = useWidgetNavigation();
  const recent = useMemo(
    () =>
      (Array.isArray(conversations) ? [...conversations] : [])
        .sort(byUpdatedDesc)
        .slice(0, MAX_HOME_CONVERSATIONS),
    [conversations],
  );

  // Render nothing until there are conversations. The always-visible home
  // surface (#9143) must not show an empty placeholder card — empty-state hints
  // belong on the dedicated view, not the home slot.
  if (recent.length === 0) {
    return null;
  }

  // Home slot: a single compact, icon-first, whole-card-clickable tile — the
  // most-recent conversation's title as the one datum, total count as the
  // badge. Tapping opens the Messages view. The sidebar keeps the full list.
  if (props.slot === "home") {
    const top = recent[0];
    const title = top.title || "Untitled";
    return (
      <HomeWidgetCard
        icon={<MessageSquare />}
        label="Messages"
        value={title}
        meta={formatRelativeTime(top.updatedAt)}
        badge={recent.length > 1 ? recent.length : undefined}
        testId="widget-messages"
        ariaLabel={`Messages: ${recent.length} recent, latest ${title}. Open Messages.`}
        onActivate={() => nav.openView("/messages", "messages")}
      />
    );
  }

  return (
    <WidgetSection
      title="Messages"
      icon={<MessageSquare />}
      testId="widget-messages"
    >
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
    </WidgetSection>
  );
}
