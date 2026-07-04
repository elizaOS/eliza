/**
 * Icon-first home widget surfacing the top relationship signal — a pending
 * identity-merge to confirm, else the stalest contact to reach out to (see the
 * `RelationshipsAttentionWidget` JSDoc below). One of the home-attention widget
 * family; publishes into the shared home-attention store to rank itself on the
 * home surface.
 */
import { Users } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { client } from "../../../api";
import { supportsFullAppShellRoutes } from "../../../api/app-shell-capabilities";
// Real wire types for the relationships routes (READ, not guessed):
// packages/ui/src/api/client-types-relationships.ts
//   - RelationshipsPersonSummary: { groupId, displayName, lastInteractionAt? , … }
//   - RelationshipsMergeCandidate: { id, status: "pending"|"accepted"|"rejected", … }
import type {
  RelationshipsMergeCandidate,
  RelationshipsPersonSummary,
} from "../../../api/client-types-relationships";
import { useIntervalWhenDocumentVisible } from "../../../hooks";
import { useIsAuthenticated } from "../../../hooks/useAuthStatus";
import { usePublishHomeAttention } from "../../../widgets/home-attention-store";
import { HOME_SIGNAL_WEIGHTS } from "../../../widgets/home-priority";
import type { WidgetProps } from "../../../widgets/types";
import { HomeWidgetCard, useWidgetNavigation } from "./home-widget-card";

const RELATIONSHIPS_WIDGET_KEY = "relationships/relationships.attention";

// Relationships data changes slowly (merge candidates, last-interaction
// recency); the full-page view loads on demand without polling, so a calm
// 30s refresh is plenty for the glanceable home card.
const RELATIONSHIPS_REFRESH_INTERVAL_MS = 30_000;

interface RelationshipsAttentionData {
  pendingCandidates: RelationshipsMergeCandidate[];
  staleContacts: RelationshipsPersonSummary[];
}

const EMPTY_DATA: RelationshipsAttentionData = {
  pendingCandidates: [],
  staleContacts: [],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * The candidates route is untrusted network input — validate the shape at the
 * boundary and keep only the fields this widget reads, typed as the real
 * RelationshipsMergeCandidate wire type.
 */
function pendingCandidatesFrom(
  candidates: RelationshipsMergeCandidate[],
): RelationshipsMergeCandidate[] {
  if (!Array.isArray(candidates)) return [];
  return candidates.filter(
    (candidate): candidate is RelationshipsMergeCandidate =>
      isRecord(candidate) &&
      typeof candidate.id === "string" &&
      candidate.status === "pending",
  );
}

function toTimestamp(iso: string | undefined): number {
  if (!iso) return 0;
  const parsed = Date.parse(iso);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * Non-owner people sorted by the OLDEST lastInteractionAt first ("haven't
 * talked to X"). A missing `lastInteractionAt` is a valid state — a contact
 * you've never interacted with — and the backend legitimately omits it (it is
 * optional on RelationshipsPersonSummary; the graph builder only sets it when a
 * lastModified exists). Those contacts are the *stalest* of all, so they're
 * kept (toTimestamp maps `undefined → 0`, sorting them first) rather than
 * silently dropped, which would empty the card whenever no one has a recorded
 * interaction.
 */
function staleContactsFrom(
  people: RelationshipsPersonSummary[],
): RelationshipsPersonSummary[] {
  if (!Array.isArray(people)) return [];
  return people
    .filter(
      (person): person is RelationshipsPersonSummary =>
        isRecord(person) &&
        typeof person.displayName === "string" &&
        !person.isOwner,
    )
    .sort(
      (left, right) =>
        toTimestamp(left.lastInteractionAt) -
        toTimestamp(right.lastInteractionAt),
    );
}

/** Shallow content equality so an unchanged 30s poll doesn't re-render. */
function relationshipsEqual(
  a: RelationshipsAttentionData,
  b: RelationshipsAttentionData,
): boolean {
  if (
    a.pendingCandidates.length !== b.pendingCandidates.length ||
    a.staleContacts.length !== b.staleContacts.length
  ) {
    return false;
  }
  const sameCandidates = a.pendingCandidates.every(
    (candidate, i) => candidate.id === b.pendingCandidates[i].id,
  );
  if (!sameCandidates) return false;
  return a.staleContacts.every((person, i) => {
    const other = b.staleContacts[i];
    return (
      person.groupId === other.groupId &&
      person.lastInteractionAt === other.lastInteractionAt
    );
  });
}

/**
 * RELATIONSHIPS "People" home widget (#9143). Glanceable, icon-first summary of
 * the single highest-priority relationship signal: a pending merge that needs
 * the user to confirm (approval), otherwise the stalest contact to reach out
 * to. Reads the same relationships routes the full view uses
 * (client.getRelationshipsPeople / getRelationshipsCandidates), polling quietly
 * while the document is visible. Tapping the card opens the Relationships view.
 */
export function RelationshipsAttentionWidget({
  slot,
  spanClassName = "col-span-2 row-span-1",
}: Partial<WidgetProps>) {
  const [data, setData] = useState<RelationshipsAttentionData>(EMPTY_DATA);
  const nav = useWidgetNavigation();
  // Auth gate (#11084): the widget mounts before the auth probe resolves, so
  // the relationships poll must stay dormant until the session is authenticated.
  const authenticated = useIsAuthenticated();

  const load = useCallback(async () => {
    if (!authenticated || !supportsFullAppShellRoutes(client.getBaseUrl())) {
      setData(EMPTY_DATA);
      return;
    }
    try {
      const [peopleResult, candidates] = await Promise.all([
        client.getRelationshipsPeople(),
        client.getRelationshipsCandidates(),
      ]);
      const next: RelationshipsAttentionData = {
        pendingCandidates: pendingCandidatesFrom(candidates),
        staleContacts: staleContactsFrom(peopleResult.people),
      };
      // Skip the state update (and the re-render) when the poll is unchanged.
      setData((prev) => (relationshipsEqual(prev, next) ? prev : next));
    } catch {
      // error-policy:J4 glance tile — keep the last good data on a poll
      // failure; never surface a broken card (todo.tsx pattern).
    }
  }, [authenticated]);

  useEffect(() => {
    void load();
  }, [load]);
  // Pause the silent poll while the document is backgrounded.
  useIntervalWhenDocumentVisible(
    () => void load(),
    RELATIONSHIPS_REFRESH_INTERVAL_MS,
  );

  const pendingCount = data.pendingCandidates.length;
  const hasPendingMerge = pendingCount > 0;
  const stalest = useMemo(() => data.staleContacts[0] ?? null, [data]);
  const hasContacts = stalest != null;
  const onHome = slot === "home";

  // A pending merge needs the user to confirm/reject — approval-level attention.
  // Overdue contacts are informational only (rank by base order, no boost).
  usePublishHomeAttention(
    RELATIONSHIPS_WIDGET_KEY,
    onHome && hasPendingMerge ? HOME_SIGNAL_WEIGHTS.approval : null,
  );

  // Render nothing when there are no pending merges AND no contacts to surface.
  // `data` starts empty, so this also covers the very first load while it's
  // still pending and nothing is cached — the home surface must not show empty
  // placeholders (#9143).
  if (!hasPendingMerge && !hasContacts) return null;

  // One high-priority datum, icon-first: a pending merge (approval) wins;
  // otherwise the stalest contact to reach out to. Tapping opens Relationships.
  if (hasPendingMerge) {
    return (
      <div className={`min-w-0 ${spanClassName}`}>
        <HomeWidgetCard
          icon={<Users />}
          label="People"
          value="Confirm merge?"
          badge={pendingCount}
          tone="warn"
          testId="chat-widget-relationships"
          ariaLabel={`People: ${pendingCount} merge ${pendingCount === 1 ? "candidate" : "candidates"} to confirm. Open Relationships.`}
          onActivate={() => nav.openView("/relationships", "relationships")}
        />
      </div>
    );
  }
  return (
    <div className={`min-w-0 ${spanClassName}`}>
      <HomeWidgetCard
        icon={<Users />}
        label="Reach out"
        value={stalest.displayName}
        tone="default"
        testId="chat-widget-relationships"
        ariaLabel={`Reach out: you haven't talked to ${stalest.displayName} in a while. Open Relationships.`}
        onActivate={() => nav.openView("/relationships", "relationships")}
      />
    </div>
  );
}

export const RELATIONSHIPS_HOME_WIDGET = {
  pluginId: "relationships",
  id: "relationships.attention",
  order: 90,
  signalKinds: ["nudge", "approval"],
  Component: RelationshipsAttentionWidget,
} as const;
