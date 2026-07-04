/**
 * Paginated activity feed for the Relationships workspace: streams recent
 * relationship events (new identities, links, tag changes) from the
 * relationships API and renders them grouped by day with type icons. A sidebar
 * panel within RelationshipsWorkspaceView.
 */

import { Fingerprint, Link2, Tags } from "lucide-react";
import { type ComponentType, useEffect, useRef, useState } from "react";
import { client } from "../../../api/client";
import type { RelationshipsActivityItem } from "../../../api/client-types-relationships";
import { formatDateTime, formatShortDate } from "../../../utils/format";
import { Button } from "../../ui/button";

type ActivityType = RelationshipsActivityItem["type"];

const ACTIVITY_TYPE_ICONS: Record<
  ActivityType,
  ComponentType<{ className?: string }>
> = {
  relationship: Link2,
  fact: Tags,
  identity: Fingerprint,
};

const ACTIVITY_PAGE_SIZE = 25;
/** Max retained activity rows (20 pages) so long sessions stay bounded. */
const ACTIVITY_MAX_ITEMS = 500;

export function RelationshipsActivityFeed() {
  const [activity, setActivity] = useState<RelationshipsActivityItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Total rows fetched from the server — the pagination offset. Tracked
  // separately from `activity.length` because the retained array is capped at
  // ACTIVITY_MAX_ITEMS, so its length stops reflecting the true server offset.
  const fetchedCountRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void client
      .getRelationshipsActivity(ACTIVITY_PAGE_SIZE, 0)
      .then((response) => {
        if (!cancelled) {
          fetchedCountRef.current = response.activity.length;
          setActivity(response.activity);
          setHasMore(response.hasMore);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(
            err instanceof Error
              ? err.message
              : "Failed to load activity feed.",
          );
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const loadMore = () => {
    setLoadingMore(true);
    setError(null);
    void client
      .getRelationshipsActivity(ACTIVITY_PAGE_SIZE, fetchedCountRef.current)
      .then((response) => {
        fetchedCountRef.current += response.activity.length;
        // Cap retained rows so a long pagination session stays bounded; older
        // rows drop off the top.
        setActivity((current) =>
          [...current, ...response.activity].slice(-ACTIVITY_MAX_ITEMS),
        );
        setHasMore(response.hasMore);
      })
      .catch((err) =>
        setError(
          err instanceof Error ? err.message : "Failed to load activity feed.",
        ),
      )
      .finally(() => setLoadingMore(false));
  };

  if (loading) {
    return (
      <div className="px-4 py-3 text-sm text-muted">Loading activity…</div>
    );
  }

  if (error) {
    return (
      <div className="rounded-sm border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger">
        {error}
      </div>
    );
  }

  if (activity.length === 0) {
    return <p className="px-4 py-3 text-sm text-muted">No activity.</p>;
  }

  return (
    <div className="space-y-1.5">
      {activity.map((item) => {
        const ActivityIcon = ACTIVITY_TYPE_ICONS[item.type];
        return (
          <div
            key={`${item.personId}-${item.type}-${item.timestamp ?? "none"}-${item.summary}`}
            className="flex items-center gap-2.5 px-2.5 py-2"
          >
            <span
              role="img"
              aria-label={`${item.type} event`}
              title={item.type}
              className="inline-flex h-5 w-5 shrink-0 items-center justify-center text-muted"
            >
              <ActivityIcon className="h-3.5 w-3.5" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-semibold text-txt">
                {item.summary}
              </div>
              {item.detail ? (
                <div className="truncate text-xs text-muted">{item.detail}</div>
              ) : null}
            </div>
            {item.timestamp ? (
              <span
                className="shrink-0 text-2xs text-muted"
                title={formatDateTime(item.timestamp, { fallback: "" })}
              >
                {formatShortDate(item.timestamp, { fallback: "" })}
              </span>
            ) : null}
          </div>
        );
      })}
      {hasMore ? (
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-8 rounded-sm px-3"
          disabled={loadingMore}
          onClick={loadMore}
        >
          {loadingMore ? "Loading..." : "Load more"}
        </Button>
      ) : null}
    </div>
  );
}
