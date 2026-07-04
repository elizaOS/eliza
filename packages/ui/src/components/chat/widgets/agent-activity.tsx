/**
 * Home tile summarizing the agent's recent feed activity — the latest few
 * `FeedActivityItem`s with a total count, fetched through the API client and
 * validated at the boundary. The fetch is bounded by a timeout so a hung agent
 * channel settles the tile to empty rather than spinning on "Loading…" forever.
 */
import { Activity } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { client } from "../../../api";
// Real wire types for the feed agent-activity route (READ, not guessed):
// packages/ui/src/api/client-types-feed.ts
//   - FeedActivityItem: { id, type, timestamp, summary?, contentPreview?, ticker?, … }
//   - FeedActivityFeed: { items: FeedActivityItem[]; total: number }
import type { FeedActivityItem } from "../../../api/client-types-feed";
import { useIsAuthenticated } from "../../../hooks/useAuthStatus";
import { withTimeout } from "../../../utils/with-timeout";
import type { WidgetProps } from "../../../widgets/types";
import { HomeWidgetCard, useWidgetNavigation } from "./home-widget-card";

const ACTIVITY_FETCH_LIMIT = 5;
// Bound the bridge call so a hung agent channel settles the tile (empty) rather
// than spinning on "Loading…" forever (the reported stuck-loading bug).
const ACTIVITY_TIMEOUT_MS = 6_000;

interface AgentActivityState {
  items: FeedActivityItem[];
  total: number;
  /** True until the first fetch settles — distinguishes "loading" from "empty". */
  loading: boolean;
}

const INITIAL_STATE: AgentActivityState = {
  items: [],
  total: 0,
  loading: true,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * The activity route is untrusted network input — validate the shape at the
 * boundary and keep only items with the fields this widget reads, typed as the
 * real FeedActivityItem wire type.
 */
function activityItemsFrom(items: unknown): FeedActivityItem[] {
  if (!Array.isArray(items)) return [];
  return items.filter(
    (item): item is FeedActivityItem =>
      isRecord(item) &&
      typeof item.id === "string" &&
      typeof item.type === "string" &&
      typeof item.timestamp === "string",
  );
}

/**
 * The single glanceable datum for an activity item: its one-line summary, else
 * a content preview, else a humanised type. Always a non-empty string so the
 * card never renders a blank value.
 */
function describeActivity(item: FeedActivityItem): string {
  const summary = item.summary?.trim();
  if (summary) return summary;
  const preview = item.contentPreview?.trim();
  if (preview) return preview;
  if (item.ticker) return `${item.type} ${item.ticker}`;
  return item.type;
}

/**
 * Feed AGENT ACTIVITY home widget. Glanceable, icon-first surface of the feed
 * agent's most-recent action (post / comment / trade / message) plus a "+N"
 * badge for the rest. Distinct from agent-orchestrator.activity (which surfaces
 * orchestrated app-runs); this reads the feed agent's own actions via
 * client.getFeedAgentActivity. Tapping opens the feed/activity view.
 *
 * Zero-setup: no connect gate. Renders nothing only after the first fetch
 * settles with zero items, so the home surface never shows an empty placeholder.
 */
export function AgentActivityWidget({
  spanClassName = "col-span-2 row-span-1",
}: Partial<WidgetProps>) {
  const [state, setState] = useState<AgentActivityState>(INITIAL_STATE);
  const nav = useWidgetNavigation();
  // Auth gate (#11084): the widget mounts before the auth probe resolves, so
  // the one-shot activity fetch must stay dormant until the session is
  // authenticated (it fires once the phase flips).
  const authenticated = useIsAuthenticated();

  const load = useCallback(async (signal: { cancelled: boolean }) => {
    try {
      const feed = await withTimeout(
        client.getFeedAgentActivity({ limit: ACTIVITY_FETCH_LIMIT }),
        ACTIVITY_TIMEOUT_MS,
      );
      if (signal.cancelled) return;
      const items = activityItemsFrom(feed?.items);
      const total =
        typeof feed?.total === "number" && feed.total >= items.length
          ? feed.total
          : items.length;
      setState({ items, total, loading: false });
    } catch {
      // error-policy:J4 glance tile — settle to empty so the card resolves
      // rather than spinning forever; never surface a broken card.
      if (signal.cancelled) return;
      setState({ items: [], total: 0, loading: false });
    }
  }, []);

  useEffect(() => {
    if (!authenticated) return;
    const signal = { cancelled: false };
    void load(signal);
    return () => {
      signal.cancelled = true;
    };
  }, [authenticated, load]);

  const latest = state.items[0] ?? null;
  // "+N" counts the activity not shown as the single datum.
  const extraCount = Math.max(0, state.total - 1);

  if (state.loading) {
    return (
      <div className={spanClassName}>
        <HomeWidgetCard
          icon={<Activity />}
          label="Activity"
          value="Loading…"
          testId="chat-widget-agent-activity"
          ariaLabel="Agent activity loading."
          onActivate={() => nav.openView("/apps/feed", "feed")}
        />
      </div>
    );
  }

  // Settled with nothing to show: the home surface must not render an empty
  // placeholder (#9143), and this is a zero-setup widget, so render nothing.
  if (!latest) return null;

  return (
    <div className={spanClassName}>
      <HomeWidgetCard
        icon={<Activity />}
        label="Activity"
        value={describeActivity(latest)}
        badge={extraCount > 0 ? `+${extraCount}` : undefined}
        testId="chat-widget-agent-activity"
        ariaLabel={`Agent activity: ${describeActivity(latest)}${
          extraCount > 0 ? `, and ${extraCount} more` : ""
        }. Open the feed.`}
        onActivate={() => nav.openView("/apps/feed", "feed")}
      />
    </div>
  );
}
