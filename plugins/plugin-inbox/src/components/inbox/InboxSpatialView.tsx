/**
 * InboxSpatialView — the cross-channel inbox authored once with the spatial
 * vocabulary so it renders correctly wherever it is displayed:
 *
 *   - GUI / XR — mounted in `<SpatialSurface>` (DOM; XR scales up).
 *   - TUI      — rendered to real terminal lines by the agent terminal, via
 *                `registerSpatialTerminalView` (see `register-terminal-view.tsx`).
 *
 * It is purely presentational (a snapshot + an action callback in, primitives
 * out) and imports ONLY the cross-modality primitives plus the view's local
 * display types, so it is safe to render in the Node agent process where the
 * terminal lives (no `@elizaos/ui` renderer barrel, no fetch).
 *
 * The live data wrapper {@link InboxView} owns the `/api/lifeops/inbox` fetch,
 * the background poll, and the channel-filter state; it builds an
 * {@link InboxSnapshot} and dispatches user intent back through `onAction`.
 */

import {
  Button,
  Card,
  Divider,
  HStack,
  List,
  Text,
  VStack,
} from "@elizaos/ui/spatial";
import {
  INBOX_CHANNEL_LABELS,
  INBOX_CHANNELS,
  type InboxChannel,
  type InboxItem,
} from "../../types.ts";

/** Which fetch state the inbox surface is currently in. */
export type InboxStatus = "loading" | "error" | "empty" | "ready";

/** One channel chip's display state in the filter row. */
export interface InboxChannelFilter {
  channel: InboxChannel;
  label: string;
  active: boolean;
}

/**
 * One degraded inbox source for the warning banner: which connector, why, and
 * the `reconnect:<source>` affordance target.
 */
export interface InboxDegradedSource {
  /** Source key from the server payload ("gmail", "x_dm", "chat"). */
  source: string;
  /** Human-readable connector name ("Gmail", "X DMs", "Chat channels"). */
  label: string;
  /** First structured degradation message from the connector. */
  message: string;
}

export interface InboxSnapshot {
  /** Current fetch state. */
  status: InboxStatus;
  /** Triage items (already filtered to the active channel selection). */
  items: InboxItem[];
  /** Channel filter chips in display order. */
  filters: InboxChannelFilter[];
  /** Number of active channel filters (drives the empty-state copy). */
  activeFilterCount: number;
  /** True when at least one channel reported messages in the payload. */
  hasConnectedChannels: boolean;
  /**
   * Degraded connector sources reported by the server. Required: an empty
   * list means every source is healthy; a non-empty list renders the warning
   * banner so an empty inbox can never pass for "inbox zero" while a
   * connector is broken.
   */
  degradedSources: InboxDegradedSource[];
  /** Proactive one-liner ("N threads still need a reply"); absent when zero. */
  nudge?: string | null;
  /** Error text for the error state. */
  error?: string | null;
}

const DEFAULT_FILTERS: InboxChannelFilter[] = INBOX_CHANNELS.map((channel) => ({
  channel,
  label: INBOX_CHANNEL_LABELS[channel],
  active: false,
}));

/** A snapshot every surface can render before live data arrives. */
export const EMPTY_INBOX_SNAPSHOT: InboxSnapshot = {
  status: "loading",
  items: [],
  filters: DEFAULT_FILTERS,
  activeFilterCount: 0,
  hasConnectedChannels: false,
  degradedSources: [],
  nudge: null,
  error: null,
};

interface InboxChannelGroup {
  channel: InboxChannel;
  label: string;
  items: InboxItem[];
}

/** Group items by channel in display order; only channels with items appear. */
function groupByChannel(items: InboxItem[]): InboxChannelGroup[] {
  const groups: InboxChannelGroup[] = [];
  for (const channel of INBOX_CHANNELS) {
    const channelItems = items.filter((item) => item.channel === channel);
    if (channelItems.length === 0) continue;
    groups.push({
      channel,
      label: INBOX_CHANNEL_LABELS[channel],
      items: channelItems,
    });
  }
  return groups;
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

export interface InboxSpatialViewProps {
  snapshot: InboxSnapshot;
  /**
   * Dispatch by agent id: `retry`, `connect`, `channel:<id>` (toggle a channel
   * filter), `open:<messageId>` (open a triage item), and
   * `reconnect:<source>` (fix a degraded connector).
   */
  onAction?: (action: string) => void;
}

export function InboxSpatialView({
  snapshot,
  onAction,
}: InboxSpatialViewProps) {
  const dispatch = (action: string) => () => onAction?.(action);

  return (
    <Card gap={2} padding={1}>
      <InboxChannelFilters filters={snapshot.filters} dispatch={dispatch} />
      {snapshot.status !== "loading" && snapshot.status !== "error" ? (
        <InboxDegradedBanner
          degradedSources={snapshot.degradedSources}
          dispatch={dispatch}
        />
      ) : null}
      <InboxBody snapshot={snapshot} dispatch={dispatch} />
    </Card>
  );
}

/**
 * Per-connector degradation rows: which source is broken, the structured
 * reason, and a Reconnect handoff into chat. Rendered above the list in both
 * the ready and empty states — an empty inbox with a dead connector must read
 * as "Gmail is broken", never as "inbox zero".
 */
function InboxDegradedBanner({
  degradedSources,
  dispatch,
}: {
  degradedSources: InboxDegradedSource[];
  dispatch: (action: string) => () => void;
}) {
  if (degradedSources.length === 0) return null;
  return (
    <VStack gap={1} shrink={0}>
      {degradedSources.map((source) => (
        <HStack key={source.source} gap={1} align="center" shrink={0}>
          <VStack gap={0} grow={1}>
            <Text bold tone="danger" wrap={false}>
              {`${source.label} unavailable`}
            </Text>
            <Text style="caption" tone="muted">
              {source.message}
            </Text>
          </VStack>
          <Button
            variant="outline"
            tone="danger"
            agent={`reconnect:${source.source}`}
            onPress={dispatch(`reconnect:${source.source}`)}
            shrink={0}
          >
            Reconnect
          </Button>
        </HStack>
      ))}
    </VStack>
  );
}

function InboxChannelFilters({
  filters,
  dispatch,
}: {
  filters: InboxChannelFilter[];
  dispatch: (action: string) => () => void;
}) {
  return (
    <HStack gap={1} wrap align="center" shrink={0}>
      {filters.map((filter) => (
        <Button
          key={filter.channel}
          variant={filter.active ? "solid" : "outline"}
          tone={filter.active ? "primary" : "default"}
          agent={`inbox-channel-${filter.channel}`}
          onPress={dispatch(`channel:${filter.channel}`)}
        >
          {filter.active ? `* ${filter.label}` : filter.label}
        </Button>
      ))}
    </HStack>
  );
}

function InboxBody({
  snapshot,
  dispatch,
}: {
  snapshot: InboxSnapshot;
  dispatch: (action: string) => () => void;
}) {
  if (snapshot.status === "loading") {
    return (
      <Text tone="muted" align="center" style="caption">
        Loading inbox
      </Text>
    );
  }

  if (snapshot.status === "error") {
    return (
      <VStack gap={1}>
        <Text bold>Couldn't load inbox</Text>
        <Text tone="danger" style="caption">
          {snapshot.error ?? "Could not load inbox."}
        </Text>
        <Button width="100%" agent="retry" onPress={dispatch("retry")}>
          Retry
        </Button>
      </VStack>
    );
  }

  if (snapshot.status === "empty" || snapshot.items.length === 0) {
    return <InboxEmptyBody snapshot={snapshot} dispatch={dispatch} />;
  }

  return <InboxReadyBody snapshot={snapshot} dispatch={dispatch} />;
}

function InboxEmptyBody({
  snapshot,
  dispatch,
}: {
  snapshot: InboxSnapshot;
  dispatch: (action: string) => () => void;
}) {
  // A degraded connector means this emptiness is NOT verified: some sources
  // could not be checked, so never claim "inbox zero" or push "Connect".
  if (snapshot.degradedSources.length > 0) {
    const labels = snapshot.degradedSources
      .map((source) => source.label)
      .join(", ");
    return (
      <VStack gap={1}>
        <Text bold>No messages from reachable channels</Text>
        <Text tone="muted" style="caption">
          {`${labels} could not be checked — this may not be everything.`}
        </Text>
      </VStack>
    );
  }
  const noChannels =
    !snapshot.hasConnectedChannels && snapshot.activeFilterCount === 0;
  if (noChannels) {
    return (
      <VStack gap={1}>
        <Text bold>None</Text>
        <Button width="100%" agent="connect" onPress={dispatch("connect")}>
          Connect
        </Button>
      </VStack>
    );
  }
  return (
    <VStack gap={1}>
      <Text bold>Inbox zero</Text>
    </VStack>
  );
}

function InboxReadyBody({
  snapshot,
  dispatch,
}: {
  snapshot: InboxSnapshot;
  dispatch: (action: string) => () => void;
}) {
  const groups = groupByChannel(snapshot.items);
  return (
    <>
      {snapshot.nudge ? (
        <Text tone="muted" style="caption" shrink={0}>
          {snapshot.nudge}
        </Text>
      ) : null}
      {groups.map((group) => (
        <InboxChannelGroupBody
          key={group.channel}
          group={group}
          dispatch={dispatch}
        />
      ))}
    </>
  );
}

function InboxChannelGroupBody({
  group,
  dispatch,
}: {
  group: InboxChannelGroup;
  dispatch: (action: string) => () => void;
}) {
  return (
    <>
      <Divider label={`${group.label} (${group.items.length})`} shrink={0} />
      <List gap={1} shrink={0}>
        {group.items.slice(0, 12).map((item) => {
          const title = item.subject ?? item.sender;
          const meta = item.preview
            ? `${item.sender} - ${item.preview}`
            : item.sender;
          return (
            // The message text uses two lines in one row so short landscape
            // viewports do not collapse title/meta lines into each other.
            <HStack key={item.id} gap={1} align="center" shrink={0}>
              <Text tone="primary" wrap={false} shrink={0}>
                {item.unread ? "●" : "○"}
              </Text>
              <VStack gap={0} grow={1}>
                <Text bold grow={1} wrap={false}>
                  {title}
                </Text>
                <Text style="caption" tone="muted" grow={1} wrap={false}>
                  {meta} • {formatTime(item.receivedAt)}
                </Text>
              </VStack>
              <Button
                variant="outline"
                tone="default"
                agent={`open:${item.id}`}
                onPress={dispatch(`open:${item.id}`)}
                shrink={0}
              >
                Open
              </Button>
            </HStack>
          );
        })}
      </List>
    </>
  );
}
