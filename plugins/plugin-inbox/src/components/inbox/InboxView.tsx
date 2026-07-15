/**
 * InboxView — the GUI data wrapper for the cross-channel inbox.
 *
 * It owns the live inbox data (the single read-only endpoint served by the
 * personal-assistant routes, the background poll, the channel-filter selection,
 * and the loading/error/empty/ready state machine) and renders the one
 * presentational {@link InboxSpatialView} inside a {@link SpatialSurface}.
 * Omitting the `modality` prop lets `SpatialSurface` render the browser DOM
 * surface today while the retained modality contract stays available for future
 * adapters.
 *
 * Data source (PA owns the persistence + connector pulls; this plugin renders):
 *   GET {base}/api/lifeops/inbox?channels=
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

import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  INBOX_CHANNEL_LABELS,
  INBOX_CHANNELS,
  type InboxChannel,
  type InboxItem,
} from "../../types.ts";
import {
  type InboxChannelFilter,
  type InboxDegradedSource,
  type InboxSnapshot,
  InboxSpatialView,
  type InboxStatus,
} from "./InboxSpatialView.tsx";

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

interface InboxSourceDegradationWire {
  axis: string;
  code: string;
  message: string;
  retryable: boolean;
}

export interface InboxSourceStatusWire {
  source: string;
  state: string;
  degradations: InboxSourceDegradationWire[];
}

interface InboxWire {
  messages: InboxMessageWire[];
  channelCounts: Record<string, InboxChannelCountWire>;
  fetchedAt: string;
  /** Per-source connector health (`LifeOpsInboxSourceStatus` in shared). */
  sources: InboxSourceStatusWire[];
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

/** Background poll cadence — keeps the list fresh without a manual refresh. */
const INBOX_POLL_MS = 20_000;

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

const SOURCE_LABELS: Record<string, string> = {
  gmail: "Gmail",
  x_dm: "X DMs",
  chat: "Chat channels",
};

/**
 * Map the server's per-source health onto banner rows. Only `degraded`
 * sources render — `disconnected` sources are handled by the connect empty
 * state, and `ok` sources need no chrome. The wire payload is validated at
 * this boundary because it crosses a JSON edge.
 */
function mapDegradedSources(
  sources: InboxSourceStatusWire[],
): InboxDegradedSource[] {
  const degraded: InboxDegradedSource[] = [];
  for (const status of sources) {
    if (status.state !== "degraded") continue;
    const messages = status.degradations
      .map((entry) => entry.message)
      .filter((message) => typeof message === "string" && message.length > 0);
    degraded.push({
      source: status.source,
      label: SOURCE_LABELS[status.source] ?? status.source,
      message: messages[0] ?? "This connector is degraded.",
    });
  }
  return degraded;
}

/**
 * Proactive one-liner (DESIGN LAW 10): the agent noticing unread threads that
 * still need a reply. Returns null when nothing is unread so the line is absent
 * rather than reading "0 threads". Computed from the already-loaded items.
 */
function unreadNudge(items: InboxItem[]): string | null {
  const unread = items.reduce((n, item) => (item.unread ? n + 1 : n), 0);
  if (unread === 0) return null;
  return `${unread} thread${unread === 1 ? " still needs" : "s still need"} a reply.`;
}

/** Single chat-handoff seam: search, reload, connect, and open all live in the
 * floating chat, so the view routes user intent there rather than computing. */
function sendChatPrompt(prompt: string): void {
  // `client` is the shared ElizaClient; its published type does not surface
  // `sendChatMessage`, so read it through a narrow optional-method view (the
  // floating chat injects it at runtime) rather than widening the client type.
  (client as { sendChatMessage?: (text: string) => void }).sendChatMessage?.(
    prompt,
  );
}

function requestConnect(): void {
  sendChatPrompt("Connect a messaging channel so you can triage my inbox.");
}

function requestReconnect(source: InboxDegradedSource | undefined): void {
  if (!source) return;
  sendChatPrompt(
    `Reconnect ${source.label} for my inbox — the connector is degraded: ${source.message}`,
  );
}

function requestOpen(item: InboxItem | undefined): void {
  if (!item) return;
  const title = item.subject ?? item.sender;
  sendChatPrompt(
    `Open the inbox thread from ${item.sender}${title ? ` — "${title}"` : ""}.`,
  );
}

// ---------------------------------------------------------------------------
// Fetch-driven state machine.
// ---------------------------------------------------------------------------

interface InboxData {
  items: InboxItem[];
  /** Channels that reported at least one message in the payload. */
  connected: InboxChannel[];
  /** Connector sources the server flagged as degraded for this payload. */
  degradedSources: InboxDegradedSource[];
}

type LoadState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; data: InboxData };

/** Stable empty array so the pre-ready memo inputs keep a constant reference. */
const EMPTY_ITEMS: InboxItem[] = [];

export function InboxView(props: InboxViewProps = {}): ReactNode {
  const fetchers = props.fetchers ?? defaultFetchers;
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [activeChannels, setActiveChannels] = useState<Set<InboxChannel>>(
    () => new Set<InboxChannel>(),
  );

  const fetchersRef = useRef(fetchers);
  fetchersRef.current = fetchers;

  // `background` skips the loading-state flash so the 20s poll refreshes the
  // already-rendered list in place; user-driven loads (mount, channel toggle,
  // retry) show the spinner.
  const load = useCallback((channels: InboxChannel[], background = false) => {
    let cancelled = false;
    if (!background) setState({ kind: "loading" });
    fetchersRef.current
      .fetchInbox(channels)
      .then((wire) => {
        if (cancelled) return;
        const items = wire.messages
          .map(mapMessage)
          .filter((item): item is InboxItem => item !== null);
        setState({
          kind: "ready",
          data: {
            items,
            connected: connectedChannels(wire.channelCounts),
            degradedSources: mapDegradedSources(
              Array.isArray(wire.sources) ? wire.sources : [],
            ),
          },
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

  // Initial load + a quiet background poll keep the view fresh without a manual
  // refresh button (search and reload both live in the chat). The poll calls the
  // same load fn against the current channel selection; it's cleared on unmount
  // and re-armed whenever the selection changes.
  useEffect(() => {
    const cancelLoad = load(activeList);
    const timer = setInterval(() => load(activeList, true), INBOX_POLL_MS);
    return () => {
      cancelLoad();
      clearInterval(timer);
    };
  }, [load, activeList]);

  const items = state.kind === "ready" ? state.data.items : EMPTY_ITEMS;

  const onAction = useCallback(
    (action: string) => {
      if (action.startsWith("channel:")) {
        const channel = action.slice("channel:".length);
        if (!isKnownChannel(channel)) return;
        setActiveChannels((prev) => {
          const next = new Set(prev);
          if (next.has(channel)) next.delete(channel);
          else next.add(channel);
          return next;
        });
        return;
      }
      if (action.startsWith("open:")) {
        const id = action.slice("open:".length);
        requestOpen(items.find((item) => item.id === id));
        return;
      }
      if (action.startsWith("reconnect:")) {
        const source = action.slice("reconnect:".length);
        requestReconnect(
          state.kind === "ready"
            ? state.data.degradedSources.find(
                (entry) => entry.source === source,
              )
            : undefined,
        );
        return;
      }
      switch (action) {
        case "retry":
          load(activeList);
          return;
        case "connect":
          requestConnect();
          return;
      }
    },
    [items, load, activeList, state],
  );

  const filters: InboxChannelFilter[] = useMemo(() => {
    const visibleChannels =
      state.kind === "ready" && state.data.connected.length > 0
        ? INBOX_CHANNELS.filter(
            (channel) =>
              state.data.connected.includes(channel) ||
              activeChannels.has(channel),
          )
        : INBOX_CHANNELS;
    return visibleChannels.map((channel) => ({
      channel,
      label: INBOX_CHANNEL_LABELS[channel],
      active: activeChannels.has(channel),
    }));
  }, [state, activeChannels]);

  const snapshot: InboxSnapshot = useMemo(() => {
    const status: InboxStatus =
      state.kind === "loading"
        ? "loading"
        : state.kind === "error"
          ? "error"
          : items.length === 0
            ? "empty"
            : "ready";
    return {
      status,
      items,
      filters,
      activeFilterCount: activeChannels.size,
      hasConnectedChannels:
        state.kind === "ready" && state.data.connected.length > 0,
      degradedSources: state.kind === "ready" ? state.data.degradedSources : [],
      nudge: unreadNudge(items),
      error: state.kind === "error" ? state.message : null,
    };
  }, [state, items, filters, activeChannels]);

  const view = <InboxSpatialView snapshot={snapshot} onAction={onAction} />;

  // While the initial fetch is in flight the placeholder lists ALL channels in
  // its filter row (the connected set is unknown until data arrives), so the
  // loading frame is denser than the settled list, which shows only connected
  // channels. A host readiness gate that samples an unsettled frame therefore
  // measures a different divider density than the settled one. Expose the shared
  // `data-view-status="loading"` settle signal (the same marker DynamicViewLoader
  // uses for bundle loading) so those gates wait for the fetch to resolve before
  // capturing, instead of racing the placeholder (#15912). Only the transient
  // loading frame is wrapped; the settled ready/empty/error renders are
  // unchanged, so nothing a screenshot captures shifts.
  if (state.kind === "loading") {
    return (
      <div
        data-view-status="loading"
        style={{
          display: "flex",
          flexDirection: "column",
          flex: "1 1 auto",
          minHeight: 0,
          minWidth: 0,
        }}
      >
        {view}
      </div>
    );
  }
  return view;
}

export default InboxView;
