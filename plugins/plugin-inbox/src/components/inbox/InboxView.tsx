/**
 * InboxView — overlay view for the cross-channel inbox.
 *
 * Data-fetching view over the single read-only inbox endpoint served by the
 * personal-assistant routes (PA owns the persistence + connector pulls; this
 * plugin only renders):
 *   GET {base}/api/lifeops/inbox?limit=&channels=
 *
 * It renders one of four distinct states (loading, error, empty, populated) and
 * instruments its refresh + channel-filter controls through the agent surface so
 * the floating chat can drive them.
 *
 * The default fetcher builds its URL from `client.getBaseUrl()`; tests inject
 * the fetcher seam so they stay offline. The wire payload is a flat list of
 * messages plus per-channel counts; we map each message to a flat display item
 * at the fetch boundary so the rest of the view renders display-only.
 *
 * This plugin MUST NOT import from @elizaos/plugin-personal-assistant. The wire
 * DTOs below are declared locally to match the JSON shape PA emits
 * (`LifeOpsInbox` / `LifeOpsInboxMessage` in @elizaos/shared).
 */

import { client } from "@elizaos/ui";
import { useAgentElement } from "@elizaos/ui/agent-surface";
import { RefreshCw } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  INBOX_CHANNEL_LABELS,
  INBOX_CHANNELS,
  type InboxChannel,
  type InboxItem,
} from "../../types.ts";

// ---------------------------------------------------------------------------
// Wire DTOs — local mirror of the JSON shape served by the PA inbox route.
// Never import PA / @elizaos/shared inbox types here; keep this view's contract
// self-contained and aligned by shape.
// ---------------------------------------------------------------------------

interface InboxMessageSenderWire {
  id: string;
  displayName: string;
  email: string | null;
  avatarUrl: string | null;
}

interface InboxMessageWire {
  id: string;
  channel: string;
  sender: InboxMessageSenderWire;
  subject: string | null;
  snippet: string;
  receivedAt: string;
  unread: boolean;
  threadId?: string;
}

interface InboxChannelCountWire {
  total: number;
  unread: number;
}

interface InboxWire {
  messages: InboxMessageWire[];
  channelCounts: Record<string, InboxChannelCountWire>;
  fetchedAt: string;
}

// ---------------------------------------------------------------------------
// Fetcher seam — default to a real GET; tests inject an offline fake.
// ---------------------------------------------------------------------------

export interface InboxFetchers {
  /** Fetch the inbox. `channels` narrows the server query when non-empty. */
  fetchInbox: (channels: InboxChannel[]) => Promise<InboxWire>;
}

async function getInbox(channels: InboxChannel[]): Promise<InboxWire> {
  const params = new URLSearchParams();
  if (channels.length > 0) params.set("channels", channels.join(","));
  const query = params.toString();
  const path = `/api/lifeops/inbox${query ? `?${query}` : ""}`;
  const response = await fetch(`${client.getBaseUrl()}${path}`);
  if (!response.ok) {
    throw new Error(`Inbox request failed (${response.status})`);
  }
  return (await response.json()) as InboxWire;
}

const defaultFetchers: InboxFetchers = {
  fetchInbox: getInbox,
};

export interface InboxViewProps {
  /** Owner display name. Reserved for host wiring; not currently rendered. */
  ownerName?: string;
  /** Test/host injection seam. Defaults to the real `/api/lifeops/inbox` GET. */
  fetchers?: InboxFetchers;
}

// ---------------------------------------------------------------------------
// Wire -> display DTO mapping.
// ---------------------------------------------------------------------------

const KNOWN_CHANNELS: ReadonlySet<string> = new Set(INBOX_CHANNELS);

function isKnownChannel(value: string): value is InboxChannel {
  return KNOWN_CHANNELS.has(value);
}

function mapMessage(message: InboxMessageWire): InboxItem | null {
  // The wire channel set is fixed; drop anything outside it rather than
  // rendering an unlabeled row. A dropped message means the server emitted a
  // channel this build doesn't know — surfaced as a smaller list, never a crash.
  if (!isKnownChannel(message.channel)) return null;
  return {
    id: message.id,
    channel: message.channel,
    sender: message.sender.displayName,
    subject: message.subject,
    preview: message.snippet,
    receivedAt: message.receivedAt,
    unread: message.unread,
    threadId: message.threadId ?? null,
  };
}

/** Channels with at least one message in the payload, in display order. */
function connectedChannels(
  counts: Record<string, InboxChannelCountWire>,
): InboxChannel[] {
  return INBOX_CHANNELS.filter((channel) => {
    const count = counts[channel];
    return count !== undefined && count.total > 0;
  });
}

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

// ---------------------------------------------------------------------------
// Styling — dark theme, CSS vars, orange accent only.
// ---------------------------------------------------------------------------

const STYLE_TAG_ID = "inbox-view-styles";

const INBOX_VIEW_CSS = `
.inbox-view-btn {
  min-height: 44px;
  min-width: 44px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 0 16px;
  border-radius: 8px;
  font-size: 14px;
  font-weight: 600;
  font-family: inherit;
  cursor: pointer;
  transition: background-color 120ms ease, border-color 120ms ease;
}
.inbox-view-btn-primary {
  background: var(--primary, #ff8a24);
  color: var(--primary-foreground, #0a0a0a);
  border: 1px solid var(--primary, #ff8a24);
}
.inbox-view-btn-primary:hover {
  background: color-mix(in srgb, var(--primary, #ff8a24) 82%, black);
  border-color: color-mix(in srgb, var(--primary, #ff8a24) 82%, black);
}
.inbox-view-btn-neutral {
  background: var(--surface, rgba(255, 255, 255, 0.04));
  color: var(--foreground, #f5f5f5);
  border: 1px solid var(--border, rgba(255, 255, 255, 0.12));
}
.inbox-view-btn-neutral:hover {
  background: color-mix(in srgb, var(--foreground, #f5f5f5) 8%, transparent);
}
.inbox-view-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.inbox-view-chip {
  min-height: 44px;
  display: inline-flex;
  align-items: center;
  padding: 0 16px;
  border-radius: 999px;
  font-size: 13px;
  font-weight: 600;
  font-family: inherit;
  cursor: pointer;
  transition: background-color 120ms ease, border-color 120ms ease;
  background: var(--surface, rgba(255, 255, 255, 0.04));
  color: var(--foreground, #f5f5f5);
  border: 1px solid var(--border, rgba(255, 255, 255, 0.12));
}
.inbox-view-chip:hover {
  background: color-mix(in srgb, var(--foreground, #f5f5f5) 8%, transparent);
}
.inbox-view-chip[aria-pressed="true"] {
  background: var(--primary, #ff8a24);
  color: var(--primary-foreground, #0a0a0a);
  border-color: var(--primary, #ff8a24);
}
.inbox-view-chip[aria-pressed="true"]:hover {
  background: color-mix(in srgb, var(--primary, #ff8a24) 82%, black);
  border-color: color-mix(in srgb, var(--primary, #ff8a24) 82%, black);
}
`;

function useInboxViewStyles(): void {
  useEffect(() => {
    if (typeof document === "undefined") return;
    if (document.getElementById(STYLE_TAG_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_TAG_ID;
    style.textContent = INBOX_VIEW_CSS;
    document.head.appendChild(style);
  }, []);
}

const containerStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 16,
  padding: 24,
  height: "100%",
  boxSizing: "border-box",
  overflowY: "auto",
  background: "var(--background, #0a0a0a)",
  color: "var(--foreground, #f5f5f5)",
  fontFamily: "system-ui, sans-serif",
};

const sectionStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 8,
};

const headerRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 12,
  flexWrap: "wrap",
};

const h1Style: CSSProperties = { margin: 0, fontSize: 18, fontWeight: 600 };
const h2Style: CSSProperties = { margin: 0, fontSize: 15, fontWeight: 600 };

const cardStyle: CSSProperties = {
  padding: 16,
  borderRadius: 8,
  border: "1px solid var(--border, rgba(255,255,255,0.08))",
  background: "var(--surface, rgba(255,255,255,0.02))",
  display: "flex",
  flexDirection: "column",
  gap: 8,
};

const dimStyle: CSSProperties = {
  opacity: 0.65,
  fontSize: 13,
  lineHeight: 1.5,
};

const chipRowStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: 8,
};

const listStyle: CSSProperties = {
  listStyle: "none",
  margin: 0,
  padding: 0,
  display: "flex",
  flexDirection: "column",
};

const rowStyle: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "baseline",
  gap: 12,
  padding: "10px 0",
  borderBottom: "1px solid var(--border, rgba(255,255,255,0.06))",
  fontSize: 14,
};

const rowMainStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 2,
  minWidth: 0,
};

const senderStyle: CSSProperties = { fontWeight: 600 };

const previewStyle: CSSProperties = {
  ...dimStyle,
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
  maxWidth: "100%",
};

const metaStyle: CSSProperties = {
  ...dimStyle,
  whiteSpace: "nowrap",
  flexShrink: 0,
};

// ---------------------------------------------------------------------------
// Agent-instrumented controls (hooks cannot run inside .map()).
// ---------------------------------------------------------------------------

function RefreshButton({
  onActivate,
  disabled,
}: {
  onActivate: () => void;
  disabled: boolean;
}): ReactNode {
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: "inbox-refresh",
    role: "button",
    label: "Refresh inbox",
    group: "inbox-toolbar",
    description: "Reload the cross-channel triage queue",
    onActivate,
  });
  return (
    <button
      ref={ref}
      type="button"
      className="inbox-view-btn inbox-view-btn-neutral"
      onClick={onActivate}
      disabled={disabled}
      aria-label="Refresh"
      {...agentProps}
    >
      <RefreshCw size={16} aria-hidden />
    </button>
  );
}

function ChannelChip({
  channel,
  label,
  active,
  onToggle,
}: {
  channel: InboxChannel;
  label: string;
  active: boolean;
  onToggle: (channel: InboxChannel) => void;
}): ReactNode {
  const activate = useCallback(() => onToggle(channel), [channel, onToggle]);
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: `inbox-channel-${channel}`,
    role: "toggle",
    label: `${label} channel filter`,
    group: "inbox-channel-filters",
    description: `Show only ${label} items in the inbox`,
    status: active ? "active" : "inactive",
    onActivate: activate,
  });
  return (
    // The visible label IS the accessible name (no aria-label) so command->view
    // routing and the e2e channel-filter toggle can address it as exactly its
    // channel name (e.g. "Email"). Richer agent context lives on the descriptor.
    <button
      ref={ref}
      type="button"
      className="inbox-view-chip"
      onClick={activate}
      aria-pressed={active}
      {...agentProps}
    >
      {label}
    </button>
  );
}

function InboxHeader({
  refetch,
  busy,
}: {
  refetch: () => void;
  busy: boolean;
}): ReactNode {
  return (
    <header style={sectionStyle}>
      <div style={headerRowStyle}>
        <h1 style={h1Style}>Inbox</h1>
        <RefreshButton onActivate={refetch} disabled={busy} />
      </div>
    </header>
  );
}

function ChannelFilters({
  active,
  onToggle,
}: {
  active: ReadonlySet<InboxChannel>;
  onToggle: (channel: InboxChannel) => void;
}): ReactNode {
  return (
    // biome-ignore lint/a11y/useSemanticElements: an ARIA group of filter-chip toggles, not a form fieldset
    <div
      role="group"
      aria-label="Channel filters"
      style={chipRowStyle}
      data-testid="inbox-channel-filters"
    >
      {INBOX_CHANNELS.map((channel) => (
        <ChannelChip
          key={channel}
          channel={channel}
          label={INBOX_CHANNEL_LABELS[channel]}
          active={active.has(channel)}
          onToggle={onToggle}
        />
      ))}
    </div>
  );
}

const unreadDotStyle: CSSProperties = {
  color: "var(--primary, #ff8a24)",
  marginRight: 6,
};

function ItemRow({ item }: { item: InboxItem }): ReactNode {
  const title = item.subject ?? item.sender;
  return (
    <li style={rowStyle}>
      <span style={rowMainStyle}>
        <span style={senderStyle}>
          {item.unread ? (
            <span role="img" aria-label="Unread" style={unreadDotStyle}>
              ●
            </span>
          ) : null}
          {title}
        </span>
        <span style={previewStyle}>
          {item.sender}
          {item.preview ? ` — ${item.preview}` : ""}
        </span>
      </span>
      <span style={metaStyle}>
        {INBOX_CHANNEL_LABELS[item.channel]} · {formatTime(item.receivedAt)}
      </span>
    </li>
  );
}

function ChannelGroup({
  channel,
  items,
}: {
  channel: InboxChannel;
  items: InboxItem[];
}): ReactNode {
  return (
    <div style={cardStyle} data-testid={`inbox-group-${channel}`}>
      <h2 style={h2Style}>
        {INBOX_CHANNEL_LABELS[channel]}{" "}
        <span style={dimStyle}>({items.length})</span>
      </h2>
      <ul
        style={listStyle}
        aria-label={`${INBOX_CHANNEL_LABELS[channel]} items`}
      >
        {items.map((item) => (
          <ItemRow key={item.id} item={item} />
        ))}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Fetch-driven state machine.
// ---------------------------------------------------------------------------

interface InboxData {
  items: InboxItem[];
  /** Channels that reported at least one message in the payload. */
  connected: InboxChannel[];
}

type LoadState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; data: InboxData };

function requestConnect(): void {
  client.sendChatMessage?.(
    "Connect a messaging channel so you can triage my inbox.",
  );
}

export function InboxView(props: InboxViewProps = {}): ReactNode {
  useInboxViewStyles();

  const fetchers = props.fetchers ?? defaultFetchers;
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [activeChannels, setActiveChannels] = useState<Set<InboxChannel>>(
    () => new Set<InboxChannel>(),
  );

  const fetchersRef = useRef(fetchers);
  fetchersRef.current = fetchers;

  const load = useCallback((channels: InboxChannel[]) => {
    let cancelled = false;
    setState({ kind: "loading" });
    fetchersRef.current
      .fetchInbox(channels)
      .then((wire) => {
        if (cancelled) return;
        const items = wire.messages
          .map(mapMessage)
          .filter((item): item is InboxItem => item !== null);
        setState({
          kind: "ready",
          data: { items, connected: connectedChannels(wire.channelCounts) },
        });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setState({
          kind: "error",
          message:
            error instanceof Error ? error.message : "Could not load inbox.",
        });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Re-fetch with the server-side channel filter whenever the selection changes.
  // The active set is the single source of truth for both the query and the
  // client-side grouping, so the two can never disagree.
  const activeList = useMemo(
    () => INBOX_CHANNELS.filter((channel) => activeChannels.has(channel)),
    [activeChannels],
  );

  useEffect(() => load(activeList), [load, activeList]);

  const refetch = useCallback(() => load(activeList), [load, activeList]);

  const toggleChannel = useCallback((channel: InboxChannel) => {
    setActiveChannels((prev) => {
      const next = new Set(prev);
      if (next.has(channel)) next.delete(channel);
      else next.add(channel);
      return next;
    });
  }, []);

  if (state.kind === "loading") {
    return (
      <div style={containerStyle} data-testid="inbox-loading">
        <InboxHeader refetch={refetch} busy={true} />
        <ChannelFilters active={activeChannels} onToggle={toggleChannel} />
        <div style={{ ...cardStyle, ...dimStyle }}>Loading inbox…</div>
      </div>
    );
  }

  if (state.kind === "error") {
    return (
      <div style={containerStyle} data-testid="inbox-error">
        <InboxHeader refetch={refetch} busy={false} />
        <ChannelFilters active={activeChannels} onToggle={toggleChannel} />
        <div style={cardStyle}>
          <div style={{ fontWeight: 600 }}>Couldn’t load inbox</div>
          <div style={dimStyle}>{state.message}</div>
          <div>
            <button
              type="button"
              className="inbox-view-btn inbox-view-btn-primary"
              onClick={refetch}
              aria-label="Retry loading inbox"
            >
              Retry
            </button>
          </div>
        </div>
      </div>
    );
  }

  const { items, connected } = state.data;

  // Group items by channel in display order. Filtering already happened at the
  // server (via the channels query); grouping is presentation only.
  const groups = INBOX_CHANNELS.map((channel) => ({
    channel,
    items: items.filter((item) => item.channel === channel),
  })).filter((group) => group.items.length > 0);

  // Nothing to triage. Distinguish "no channels connected" (connect-a-channel)
  // from "connected but inbox zero" — never fabricate threads for either.
  if (items.length === 0) {
    const noChannels = connected.length === 0 && activeChannels.size === 0;
    return (
      <div style={containerStyle} data-testid="inbox-empty">
        <InboxHeader refetch={refetch} busy={false} />
        <ChannelFilters active={activeChannels} onToggle={toggleChannel} />
        <div style={cardStyle}>
          {noChannels ? (
            <>
              <div style={{ fontWeight: 600 }}>No channels connected</div>
              <div style={dimStyle}>
                Connect email, Discord, Telegram, WhatsApp, Signal, iMessage, or
                X so Eliza can triage your inbox. Nothing is shown until a
                channel is linked.
              </div>
              <div>
                <button
                  type="button"
                  className="inbox-view-btn inbox-view-btn-primary"
                  onClick={requestConnect}
                  aria-label="Connect a messaging channel"
                >
                  Connect a channel
                </button>
              </div>
            </>
          ) : (
            <>
              <div style={{ fontWeight: 600 }}>Inbox zero</div>
              <div style={dimStyle}>
                {activeChannels.size > 0
                  ? "Nothing to triage in the selected channels."
                  : "Nothing to triage right now. You’re all caught up."}
              </div>
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <div style={containerStyle} data-testid="inbox-populated">
      <InboxHeader refetch={refetch} busy={false} />
      <ChannelFilters active={activeChannels} onToggle={toggleChannel} />
      <section style={sectionStyle} aria-label="Triage queue">
        {groups.map((group) => (
          <ChannelGroup
            key={group.channel}
            channel={group.channel}
            items={group.items}
          />
        ))}
      </section>
    </div>
  );
}

export default InboxView;
