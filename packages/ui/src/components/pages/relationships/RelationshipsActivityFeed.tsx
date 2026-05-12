import { Button } from "../../ui/button";
import { Fingerprint, Link2, Tags } from "lucide-react";
import { type ComponentType, useEffect, useState } from "react";
import { client } from "../../../api/client";
import type { RelationshipsActivityItem } from "../../../api/client-types-relationships";
import { formatDateTime, formatShortDate } from "../../../utils/format";

type ActivityType = RelationshipsActivityItem["type"];

const ACTIVITY_TYPE_STYLES: Record<
  ActivityType,
  { bg: string; fg: string; icon: ComponentType<{ className?: string }> }
> = {
  relationship: {
    bg: "rgba(99, 102, 241, 0.15)",
    fg: "rgb(99, 102, 241)",
    icon: Link2,
  },
  fact: {
    bg: "rgba(34, 197, 94, 0.15)",
    fg: "rgb(34, 197, 94)",
    icon: Tags,
  },
  identity: {
    bg: "rgba(168, 85, 247, 0.15)",
    fg: "rgb(168, 85, 247)",
    icon: Fingerprint,
  },
};

const ACTIVITY_PAGE_SIZE = 25;

export function RelationshipsActivityFeed() {
  const [activity, setActivity] = useState<RelationshipsActivityItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void client
      .getRelationshipsActivity(ACTIVITY_PAGE_SIZE, 0)
      .then((response) => {
        if (!cancelled) {
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
      .getRelationshipsActivity(ACTIVITY_PAGE_SIZE, activity.length)
      .then((response) => {
        setActivity((current) => [...current, ...response.activity]);
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
      <div className="rounded-2xl border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger">
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
        const style = ACTIVITY_TYPE_STYLES[item.type];
        const ActivityIcon = style.icon;
        return (
          <div
            key={`${item.personId}-${item.type}-${item.timestamp ?? "none"}-${item.summary}`}
            className="flex items-center gap-2 rounded-lg border border-border/24 bg-card/28 px-2.5 py-2"
          >
            <span
              role="img"
              aria-label={`${item.type} event`}
              title={item.type}
              className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full"
              style={{ backgroundColor: style.bg, color: style.fg }}
            >
              <ActivityIcon className="h-3 w-3" />
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
          className="h-8 rounded-lg px-3"
          disabled={loadingMore}
          onClick={loadMore}
        >
          {loadingMore ? "Loading..." : "Load more"}
        </Button>
      ) : null}
    </div>
  );
}
