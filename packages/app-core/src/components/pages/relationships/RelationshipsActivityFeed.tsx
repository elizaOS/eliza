import { useEffect, useState } from "react";
import { client } from "../../../api/client";
import type { RelationshipsActivityItem } from "../../../api/client-types-relationships";
import { formatDateTime } from "../../../utils/format";

const ACTIVITY_TYPE_COLORS: Record<string, { bg: string; fg: string }> = {
  relationship: { bg: "rgba(99, 102, 241, 0.15)", fg: "rgb(99, 102, 241)" },
  fact: { bg: "rgba(34, 197, 94, 0.15)", fg: "rgb(34, 197, 94)" },
  identity: { bg: "rgba(168, 85, 247, 0.15)", fg: "rgb(168, 85, 247)" },
};

export function RelationshipsActivityFeed() {
  const [activity, setActivity] = useState<RelationshipsActivityItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    void client
      .getRelationshipsActivity(50)
      .then((response) => setActivity(response.activity))
      .catch((err) =>
        setError(
          err instanceof Error ? err.message : "Failed to load activity feed.",
        ),
      )
      .finally(() => setLoading(false));
  }, []);

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
    return (
      <p className="px-4 py-3 text-sm text-muted">
        No relationship activity yet. Events will appear as the agent extracts
        relationships, identities, and facts from conversations.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      {activity.map((item) => {
        const color =
          ACTIVITY_TYPE_COLORS[item.type] ?? ACTIVITY_TYPE_COLORS.relationship;
        return (
          <div
            key={`${item.personId}-${item.type}-${item.timestamp ?? "none"}-${item.summary}`}
            className="rounded-xl border border-border/24 bg-card/32 px-3 py-2.5"
          >
            <div className="flex flex-wrap items-center gap-2">
              <span
                className="inline-flex items-center rounded-full px-2 py-0.5 text-2xs font-semibold uppercase tracking-[0.12em]"
                style={{ backgroundColor: color.bg, color: color.fg }}
              >
                {item.type}
              </span>
              {item.timestamp ? (
                <span className="ml-auto text-xs-tight text-muted">
                  {formatDateTime(item.timestamp, { fallback: "" })}
                </span>
              ) : null}
            </div>
            <div className="mt-1.5 text-sm font-semibold text-txt">
              {item.summary}
            </div>
            {item.detail ? (
              <div className="mt-0.5 text-xs text-muted">{item.detail}</div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
