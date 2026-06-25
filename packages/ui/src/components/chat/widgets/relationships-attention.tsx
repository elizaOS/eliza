import { Users } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { client } from "../../../api";
// Real wire types for the relationships routes (READ, not guessed):
// packages/ui/src/api/client-types-relationships.ts
//   - RelationshipsPersonSummary: { groupId, displayName, lastInteractionAt? , … }
//   - RelationshipsMergeCandidate: { id, status: "pending"|"accepted"|"rejected", … }
import type {
  RelationshipsMergeCandidate,
  RelationshipsPersonSummary,
} from "../../../api/client-types-relationships";
import { useIntervalWhenDocumentVisible } from "../../../hooks";
import { usePublishHomeAttention } from "../../../widgets/home-attention-store";
import { HOME_SIGNAL_WEIGHTS } from "../../../widgets/home-priority";
import type { WidgetProps } from "../../../widgets/types";
import { HomeWidgetCard, useWidgetNavigation } from "./home-widget-card";

const RELATIONSHIPS_WIDGET_KEY = "relationships/relationships.attention";

// This widget owns a 2-wide footprint on the home grid; default to it when the
// host doesn't supply a span (e.g. off the home slot / direct mounts).
const DEFAULT_SPAN_CLASS = "col-span-2 row-span-1";

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
 *
 * NAKED per the home redesign: white text on the ambient orange field, no card
 * background/border (HomeWidgetCard supplies the soft text-shadow + faint white
 * hover wash). The host-supplied `spanClassName` places the 2-wide grid item.
 */
export function RelationshipsAttentionWidget({
  slot,
  spanClassName,
}: Partial<WidgetProps>) {
  const [data, setData] = useState<RelationshipsAttentionData>(EMPTY_DATA);
  const [loaded, setLoaded] = useState(false);
  const nav = useWidgetNavigation();

  const load = useCallback(async (signal: { cancelled: boolean }) => {
    try {
      const [peopleResult, candidates] = await Promise.all([
        client.getRelationshipsPeople(),
        client.getRelationshipsCandidates(),
      ]);
      if (signal.cancelled) return;
      const next: RelationshipsAttentionData = {
        pendingCandidates: pendingCandidatesFrom(candidates),
        staleContacts: staleContactsFrom(peopleResult.people),
      };
      // Skip the state update (and the re-render) when the poll is unchanged.
      setData((prev) => (relationshipsEqual(prev, next) ? prev : next));
      setLoaded(true);
    } catch {
      // Network/agent failure — keep the last good data (or empty); never
      // surface a broken card. Matches todo.tsx's silent-fallback catch.
      if (!signal.cancelled) setLoaded(true);
    }
  }, []);

  useEffect(() => {
    const token = { cancelled: false };
    void load(token);
    return () => {
      token.cancelled = true;
    };
  }, [load]);
  // Pause the silent poll while the document is backgrounded.
  useIntervalWhenDocumentVisible(() => {
    void load({ cancelled: false });
  }, RELATIONSHIPS_REFRESH_INTERVAL_MS);

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

  // Loading and connected-but-empty both render `null`: this widget is
  // zero-setup, so there is no connect affordance to show — until there is a
  // pending merge or a contact to surface, the home must not paint a placeholder
  // (#9143). `loaded` keeps us from flashing anything on the very first frame.
  if (!loaded || (!hasPendingMerge && !hasContacts)) return null;

  const span = spanClassName ?? DEFAULT_SPAN_CLASS;

  // One high-priority datum, icon-first: a pending merge (approval) wins;
  // otherwise the stalest contact to reach out to. Tapping opens Relationships.
  // The span class lands on this single root grid-item element.
  if (hasPendingMerge) {
    return (
      <div className={span}>
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
    <div className={span}>
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
