import { Users } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
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
import { WidgetSection } from "./shared";

const RELATIONSHIPS_WIDGET_KEY = "relationships/relationships.attention";

// Relationships data changes slowly (merge candidates, last-interaction
// recency); the full-page view loads on demand without polling, so a calm
// 30s refresh is plenty for the glanceable home card.
const RELATIONSHIPS_REFRESH_INTERVAL_MS = 30_000;
const MAX_STALE_CONTACTS = 3;

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
 * People sorted by the OLDEST lastInteractionAt first ("haven't talked to X").
 * People with a real (non-owner) interaction history only — owners and people
 * with no recorded interaction carry no recency signal worth surfacing.
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
        !person.isOwner &&
        typeof person.lastInteractionAt === "string",
    )
    .sort(
      (left, right) =>
        toTimestamp(left.lastInteractionAt) -
        toTimestamp(right.lastInteractionAt),
    )
    .slice(0, MAX_STALE_CONTACTS);
}

function CandidateRow() {
  return (
    <div className="flex items-center gap-2 rounded-sm border border-border/50 bg-bg/70 px-3 py-1.5">
      <span className="mt-px inline-block h-2 w-2 shrink-0 rounded-full bg-accent" />
      <span className="min-w-0 flex-1 truncate text-xs font-semibold text-txt">
        Confirm merge?
      </span>
    </div>
  );
}

function StaleContactRow({ person }: { person: RelationshipsPersonSummary }) {
  return (
    <div className="flex items-center gap-2 px-1 py-1">
      <span className="mt-px inline-block h-2 w-2 shrink-0 rounded-full bg-muted" />
      <span className="min-w-0 flex-1 truncate text-xs-tight text-muted">
        Haven't talked to {person.displayName}
      </span>
    </div>
  );
}

export function RelationshipsAttentionWidget({ slot }: Partial<WidgetProps>) {
  const [data, setData] = useState<RelationshipsAttentionData>(EMPTY_DATA);

  const load = useCallback(async () => {
    try {
      const [peopleResult, candidates] = await Promise.all([
        client.getRelationshipsPeople(),
        client.getRelationshipsCandidates(),
      ]);
      setData({
        pendingCandidates: pendingCandidatesFrom(candidates),
        staleContacts: staleContactsFrom(peopleResult.people),
      });
    } catch {
      // Network/agent failure — keep the last good data (or empty); never
      // surface a broken card. Matches todo.tsx's silent-fallback catch.
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);
  // Pause the silent poll while the document is backgrounded.
  useIntervalWhenDocumentVisible(
    () => void load(),
    RELATIONSHIPS_REFRESH_INTERVAL_MS,
  );

  const hasPendingMerge = data.pendingCandidates.length > 0;
  const hasContacts = data.staleContacts.length > 0;
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

  return (
    <WidgetSection
      title="Relationships"
      icon={<Users className="h-4 w-4" />}
      testId="chat-widget-relationships"
    >
      <div className="flex flex-col gap-2">
        {hasPendingMerge ? (
          <div className="flex flex-col gap-1">
            {data.pendingCandidates
              .slice(0, MAX_STALE_CONTACTS)
              .map((candidate) => (
                <CandidateRow key={candidate.id} />
              ))}
          </div>
        ) : null}
        {hasContacts ? (
          <div className="flex flex-col">
            {data.staleContacts.map((person) => (
              <StaleContactRow key={person.groupId} person={person} />
            ))}
          </div>
        ) : null}
      </div>
    </WidgetSection>
  );
}

export const RELATIONSHIPS_HOME_WIDGET = {
  pluginId: "relationships",
  id: "relationships.attention",
  order: 90,
  signalKinds: ["nudge", "approval"],
  Component: RelationshipsAttentionWidget,
} as const;
