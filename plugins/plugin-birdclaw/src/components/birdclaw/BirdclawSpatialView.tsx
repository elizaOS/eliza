/**
 * BirdclawSpatialView — the Birdclaw archive browser authored once with the
 * spatial vocabulary so it renders on every surface:
 *
 *   - GUI / XR — mounted in `<SpatialSurface>` (DOM; XR scales up).
 *   - TUI      — rendered to terminal lines via the spatial TUI renderer.
 *
 * Purely presentational: a snapshot + an action callback in, primitives out.
 * The live data wrapper {@link BirdclawView} owns the `/api/birdclaw/*`
 * fetches, the tab state, and the sync flow; it builds a
 * {@link BirdclawSnapshot} and dispatches user intent back through `onAction`.
 *
 * Per the app's chat-first design law, free-form search lives in the floating
 * chat (the `BIRDCLAW` action), not in an input here — the view is the
 * browse/triage surface.
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

/** Which fetch state the surface is in. `setup` = birdclaw not installed. */
export type BirdclawViewStatus =
  | "loading"
  | "setup"
  | "error"
  | "empty"
  | "ready";

/** Tabs the browser exposes; ids double as the `tab:<id>` action namespace. */
export const BIRDCLAW_TABS = [
  { id: "home", label: "Timeline" },
  { id: "mentions", label: "Mentions" },
  { id: "authored", label: "Posted" },
  { id: "likes", label: "Likes" },
  { id: "bookmarks", label: "Bookmarks" },
  { id: "inbox", label: "Inbox" },
] as const;

export type BirdclawTabId = (typeof BIRDCLAW_TABS)[number]["id"];

export interface BirdclawTabChip {
  id: BirdclawTabId;
  label: string;
  active: boolean;
}

/** One display row — a tweet or an inbox item, already flattened. */
export interface BirdclawRow {
  id: string;
  /** Leading line: "@handle" or a triage title. */
  title: string;
  /** Body text (the tweet / mention / DM content). */
  body: string;
  /** Trailing meta: likes, marks, relative facts. */
  meta: string;
  /** ISO timestamp for the row. */
  time: string;
  /** Accented rows (needs-reply mentions) render an attention dot. */
  accent: boolean;
}

export interface BirdclawSnapshot {
  status: BirdclawViewStatus;
  tabs: BirdclawTabChip[];
  rows: BirdclawRow[];
  /** Live-transport line ("xurl not installed. local mode active."). */
  transportText: string | null;
  /** True while a sync request is in flight (disables the button). */
  syncing: boolean;
  /** True when the active tab maps to a live collection AND a transport exists. */
  canSync: boolean;
  /** Proactive one-liner ("2 mentions still need a reply"); null when quiet. */
  nudge: string | null;
  /** Error text for the error state. */
  error: string | null;
  /** Install guidance for the setup state. */
  setupHint: string | null;
}

/** A snapshot every surface can render before live data arrives. */
export const EMPTY_BIRDCLAW_SNAPSHOT: BirdclawSnapshot = {
  status: "loading",
  tabs: BIRDCLAW_TABS.map((tab, index) => ({
    id: tab.id,
    label: tab.label,
    active: index === 0,
  })),
  rows: [],
  transportText: null,
  syncing: false,
  canSync: false,
  nudge: null,
  error: null,
  setupHint: null,
};

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

export interface BirdclawSpatialViewProps {
  snapshot: BirdclawSnapshot;
  /**
   * Dispatch by agent id: `tab:<id>` (switch tab), `sync` (refresh the active
   * collection), `retry` (reload after an error), and `open:<rowId>` (hand the
   * row to the floating chat for follow-up).
   */
  onAction?: (action: string) => void;
}

export function BirdclawSpatialView({
  snapshot,
  onAction,
}: BirdclawSpatialViewProps) {
  const dispatch = (action: string) => () => onAction?.(action);

  return (
    <Card gap={1} padding={1}>
      <BirdclawTabs tabs={snapshot.tabs} dispatch={dispatch} />
      <BirdclawBody snapshot={snapshot} dispatch={dispatch} />
    </Card>
  );
}

function BirdclawTabs({
  tabs,
  dispatch,
}: {
  tabs: BirdclawTabChip[];
  dispatch: (action: string) => () => void;
}) {
  return (
    <HStack gap={1} wrap align="center">
      {tabs.map((tab) => (
        <Button
          key={tab.id}
          variant={tab.active ? "solid" : "ghost"}
          tone={tab.active ? "primary" : "default"}
          agent={`birdclaw-tab-${tab.id}`}
          onPress={dispatch(`tab:${tab.id}`)}
        >
          {tab.label}
        </Button>
      ))}
    </HStack>
  );
}

function BirdclawBody({
  snapshot,
  dispatch,
}: {
  snapshot: BirdclawSnapshot;
  dispatch: (action: string) => () => void;
}) {
  if (snapshot.status === "loading") {
    return (
      <Text tone="muted" align="center" style="caption">
        Loading archive
      </Text>
    );
  }

  if (snapshot.status === "setup") {
    return (
      <VStack gap={1}>
        <Text bold>Birdclaw is not set up yet</Text>
        <Text tone="muted" style="caption">
          Birdclaw keeps a local-first archive of your Twitter/X timeline,
          mentions, likes, and bookmarks in a private SQLite database.
        </Text>
        {snapshot.setupHint ? (
          <Text style="caption">{snapshot.setupHint}</Text>
        ) : null}
        <Text tone="muted" style="caption">
          Install: brew install steipete/tap/birdclaw — then birdclaw init.
          Docs: birdclaw.sh
        </Text>
        <Button width="100%" agent="retry" onPress={dispatch("retry")}>
          Check again
        </Button>
      </VStack>
    );
  }

  if (snapshot.status === "error") {
    return (
      <VStack gap={1}>
        <Text bold>Couldn't load the archive</Text>
        <Text tone="danger" style="caption">
          {snapshot.error ?? "Could not load the birdclaw archive."}
        </Text>
        <Button width="100%" agent="retry" onPress={dispatch("retry")}>
          Retry
        </Button>
      </VStack>
    );
  }

  return (
    <>
      <BirdclawToolbar snapshot={snapshot} dispatch={dispatch} />
      {snapshot.status === "empty" || snapshot.rows.length === 0 ? (
        <Text tone="muted" align="center" style="caption">
          Nothing here yet — import an archive or sync a collection.
        </Text>
      ) : (
        <BirdclawRows rows={snapshot.rows} dispatch={dispatch} />
      )}
    </>
  );
}

function BirdclawToolbar({
  snapshot,
  dispatch,
}: {
  snapshot: BirdclawSnapshot;
  dispatch: (action: string) => () => void;
}) {
  return (
    <VStack gap={0}>
      {snapshot.nudge ? (
        <Text tone="muted" style="caption">
          {snapshot.nudge}
        </Text>
      ) : null}
      <HStack gap={1} align="center">
        <Text tone="muted" style="caption" grow={1} wrap={false}>
          {snapshot.transportText ?? ""}
        </Text>
        {snapshot.canSync ? (
          <Button
            variant="outline"
            tone="default"
            agent="birdclaw-sync"
            onPress={dispatch("sync")}
          >
            {snapshot.syncing ? "Syncing…" : "Sync"}
          </Button>
        ) : null}
      </HStack>
    </VStack>
  );
}

function BirdclawRows({
  rows,
  dispatch,
}: {
  rows: BirdclawRow[];
  dispatch: (action: string) => () => void;
}) {
  return (
    <>
      <Divider label={`${rows.length} item${rows.length === 1 ? "" : "s"}`} />
      <List gap={1}>
        {rows.map((row) => (
          <VStack key={row.id} gap={0}>
            <HStack gap={1} align="center">
              <Text tone="primary" wrap={false}>
                {row.accent ? "●" : "○"}
              </Text>
              <Text bold grow={1}>
                {row.title}
              </Text>
            </HStack>
            <Text>{row.body}</Text>
            <HStack gap={1} align="center">
              <Text style="caption" tone="muted" grow={1} wrap={false}>
                {row.meta ? `${row.meta} • ` : ""}
                {formatTime(row.time)}
              </Text>
              <Button
                variant="outline"
                tone="default"
                agent={`open:${row.id}`}
                onPress={dispatch(`open:${row.id}`)}
              >
                Ask
              </Button>
            </HStack>
          </VStack>
        ))}
      </List>
    </>
  );
}
