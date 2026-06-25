import { MessageSquare } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { client } from "../../../api/client";
import type { Conversation } from "../../../api/client-types-chat";
import { useAppSelector } from "../../../state";
import { formatRelativeTime } from "../../../utils/format";
import type { WidgetProps } from "../../../widgets/types";
import { HomeWidgetCard, useWidgetNavigation } from "./home-widget-card";
import { WidgetSection } from "./shared";

const MAX_HOME_CONVERSATIONS = 4;
const DEFAULT_SPAN = "col-span-2 row-span-1";

function byUpdatedDesc(a: Conversation, b: Conversation): number {
  return (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "");
}

/**
 * Frontpage Messages widget (#9143/#9304). The shared "messages" default
 * widget: recent conversations (title + relative time) so the home surfaces
 * quick access to recent chats. Reads the app store's conversation list
 * directly; on a cold home (store not yet hydrated) it seeds once from
 * `client.listConversations()` so the tile isn't blank on first paint.
 */
export function MessagesWidget(props: WidgetProps) {
  const storeConversations = useAppSelector((s) => s.conversations);
  const nav = useWidgetNavigation();

  // Cold-home seed: when the store has no conversations yet, fetch them once so
  // the home tile can populate before the startup-phase hydrate lands. Held in
  // local state; the store remains the source of truth once it fills.
  const [seeded, setSeeded] = useState<Conversation[] | null>(null);
  const storeHasConversations =
    Array.isArray(storeConversations) && storeConversations.length > 0;

  useEffect(() => {
    if (storeHasConversations) {
      return;
    }
    let cancelled = false;
    client
      .listConversations()
      .then((res) => {
        if (!cancelled) {
          setSeeded(res.conversations);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setSeeded([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [storeHasConversations]);

  const recent = useMemo(() => {
    const source = storeHasConversations ? storeConversations : seeded;
    return (Array.isArray(source) ? [...source] : [])
      .sort(byUpdatedDesc)
      .slice(0, MAX_HOME_CONVERSATIONS);
  }, [storeHasConversations, storeConversations, seeded]);

  // Render nothing until there are conversations. The always-visible home
  // surface (#9143) must not show an empty placeholder card — empty-state hints
  // belong on the dedicated view, not the home slot. While the cold-home seed is
  // still in flight (store empty, fetch unresolved) we also hold null.
  if (recent.length === 0) {
    return null;
  }

  // Home slot: a single compact, icon-first, whole-card-clickable tile — the
  // most-recent conversation's title as the one datum, total count as the badge.
  // Tapping opens the Messages view. The sidebar keeps the full list. The root
  // div carries the host-provided grid span so the tile occupies its 2x1 cell.
  if (props.slot === "home") {
    const top = recent[0];
    const title = top.title || "Untitled";
    return (
      <div className={`min-w-0 ${props.spanClassName ?? DEFAULT_SPAN}`}>
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
      </div>
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
