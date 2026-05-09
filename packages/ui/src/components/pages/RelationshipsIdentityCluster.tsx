import { Fingerprint } from "lucide-react";
import type { RelationshipsPersonDetail } from "../../api/client-types-relationships";

function shortLabel(value: string, maxLength = 18): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;
}

export function RelationshipsIdentityCluster({
  person,
}: {
  person: RelationshipsPersonDetail;
}) {
  if (person.identities.length === 0) {
    return null;
  }

  return (
    <ul className="space-y-1.5">
      {person.identities.map((identity) => {
        const platform = identity.platforms[0] ?? "linked";
        const primaryName = identity.names[0];
        const handles = identity.handles.map((h) => h.handle).filter(Boolean);
        const detail =
          handles.length > 0 ? handles.join(", ") : identity.entityId;
        return (
          <li
            key={identity.entityId}
            className="flex items-center gap-2 rounded-lg border border-border/24 bg-card/30 px-2.5 py-1.5 text-xs"
          >
            <Fingerprint className="h-3 w-3 shrink-0 text-accent" />
            <span className="shrink-0 rounded-full bg-card/60 px-1.5 py-0.5 text-2xs font-semibold uppercase tracking-[0.1em] text-muted">
              {shortLabel(platform.replace(/_/g, " "), 12)}
            </span>
            {primaryName ? (
              <span className="min-w-0 truncate font-semibold text-txt">
                {shortLabel(primaryName, 28)}
              </span>
            ) : null}
            <span className="ml-auto min-w-0 truncate text-muted">
              {shortLabel(detail, 32)}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
