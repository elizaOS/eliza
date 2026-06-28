import { MessageSquare } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { client } from "../../../api/client";
import type {
  Conversation,
  ConversationMessage,
} from "../../../api/client-types-chat";
import { useAppSelector } from "../../../state";
import { formatRelativeTime } from "../../../utils/format";
import type { WidgetProps } from "../../../widgets/types";
import { HomeWidgetCard, useWidgetNavigation } from "./home-widget-card";
import { WidgetSection } from "./shared";

const MAX_HOME_CONVERSATIONS = 4;
const DEFAULT_SPAN = "col-span-2 row-span-1";
/**
 * Cap on how many of the most-recent conversations we fetch messages for to
 * decide qualification. The widget only ever displays the top few, so scanning
 * the freshest slice is enough; older conversations rarely re-surface here.
 */
const MAX_SCANNED_CONVERSATIONS = 8;
/** Longest derived name (from a user message) before it's truncated. */
const DERIVED_NAME_MAX_LEN = 40;

/** Titles the server assigns to a brand-new, un-renamed conversation. */
const GENERIC_TITLES = new Set(["", "new chat", "default", "untitled"]);

/**
 * A conversation that cleared the "real back-and-forth" filter, paired with the
 * display name we derived for it (from its title or its latest user message).
 */
interface QualifyingConversation {
  conversation: Conversation;
  name: string;
}

function byUpdatedDesc(a: Conversation, b: Conversation): number {
  return (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "");
}

/** True when the title is a real, user-meaningful name (not a server default). */
function hasRealTitle(title: string | undefined): title is string {
  return !!title && !GENERIC_TITLES.has(title.trim().toLowerCase());
}

/** Collapse whitespace and clamp a derived name to a glanceable length. */
function shortenName(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > DERIVED_NAME_MAX_LEN
    ? `${collapsed.slice(0, DERIVED_NAME_MAX_LEN - 1).trimEnd()}…`
    : collapsed;
}

/**
 * The agent has genuinely responded only when an assistant message follows a
 * user message — i.e. a real exchange, not an empty draft and not a
 * greeting-only conversation (whose lone assistant turn precedes any user
 * input). Returns the latest user message text so callers can derive a name
 * from it when the conversation has no real title.
 */
function qualify(
  messages: ConversationMessage[],
): { latestUserText: string } | null {
  let seenUser = false;
  let agentResponded = false;
  let latestUserText = "";
  for (const message of messages) {
    if (message.role === "user") {
      seenUser = true;
      if (message.text.trim()) {
        latestUserText = message.text;
      }
    } else if (message.role === "assistant" && seenUser) {
      agentResponded = true;
    }
  }
  return agentResponded ? { latestUserText } : null;
}

/**
 * Frontpage Messages widget (#9143/#9304). Surfaces NAMED conversations the
 * agent has actually responded in — never empty drafts or greeting-only
 * conversations. Reads the app store's conversation list (seeding once from
 * `client.listConversations()` on a cold home), then fetches each candidate's
 * messages to keep only real back-and-forth exchanges. A qualifying name is the
 * conversation's title, or — when the title is a server default — a short name
 * derived from its latest user message. When nothing qualifies the widget
 * self-hides (returns null); it is NOT connect-gated.
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

  const candidates = useMemo(() => {
    const source = storeHasConversations ? storeConversations : seeded;
    return (Array.isArray(source) ? [...source] : [])
      .sort(byUpdatedDesc)
      .slice(0, MAX_SCANNED_CONVERSATIONS);
  }, [storeHasConversations, storeConversations, seeded]);

  // Resolve which candidates have a real exchange (and their display name) by
  // reading each conversation's messages. `candidates` is memoized, so the
  // effect only re-runs when the underlying conversation list actually changes.
  const [qualifying, setQualifying] = useState<QualifyingConversation[]>([]);

  useEffect(() => {
    if (candidates.length === 0) {
      setQualifying([]);
      return;
    }
    let cancelled = false;
    Promise.all(
      candidates.map(async (conversation) => {
        const { messages } = await client.getConversationMessages(
          conversation.id,
        );
        const result = qualify(messages);
        if (!result) {
          return null;
        }
        const name = hasRealTitle(conversation.title)
          ? conversation.title.trim()
          : result.latestUserText
            ? shortenName(result.latestUserText)
            : null;
        // No real title and no user text to name it by → not nameable, skip.
        return name ? { conversation, name } : null;
      }),
    )
      .then((results) => {
        if (cancelled) {
          return;
        }
        setQualifying(
          results
            .filter((r): r is QualifyingConversation => r !== null)
            .sort((a, b) => byUpdatedDesc(a.conversation, b.conversation))
            .slice(0, MAX_HOME_CONVERSATIONS),
        );
      })
      .catch(() => {
        if (!cancelled) {
          setQualifying([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [candidates]);

  // Self-hide until at least one named, agent-responded conversation qualifies.
  // The always-visible home surface (#9143) must never show an empty placeholder
  // card — empty-state hints belong on the dedicated /messages view.
  if (qualifying.length === 0) {
    return null;
  }

  // Home slot: one compact, icon-first, whole-card-clickable tile — the
  // most-recent qualifying conversation's name as the one datum, the count of
  // the rest as a "+N" badge. Tapping opens the Messages view. The root div
  // carries the host-provided grid span so the tile occupies its cell.
  if (props.slot === "home") {
    const top = qualifying[0];
    const overflow = qualifying.length - 1;
    return (
      <div className={`min-w-0 ${props.spanClassName ?? DEFAULT_SPAN}`}>
        <HomeWidgetCard
          icon={<MessageSquare />}
          label="Messages"
          value={top.name}
          meta={formatRelativeTime(top.conversation.updatedAt)}
          badge={overflow > 0 ? `+${overflow}` : undefined}
          testId="widget-messages"
          ariaLabel={`Messages: ${qualifying.length} active, latest ${top.name}. Open Messages.`}
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
        {qualifying.map(({ conversation, name }) => (
          <li
            key={conversation.id}
            className="flex items-center justify-between gap-2 px-1 py-1"
          >
            <span className="truncate text-xs font-medium text-txt">
              {name}
            </span>
            <span className="shrink-0 text-3xs text-muted">
              {formatRelativeTime(conversation.updatedAt)}
            </span>
          </li>
        ))}
      </ul>
    </WidgetSection>
  );
}
