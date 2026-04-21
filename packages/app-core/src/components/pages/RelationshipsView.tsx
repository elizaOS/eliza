import {
  Button,
  MetaPill,
  PageLayout,
  PagePanel,
  Sidebar,
  SidebarContent,
  SidebarHeader,
  SidebarPanel,
  SidebarScrollRegion,
} from "@elizaos/ui";
import {
  type ReactNode,
  useCallback,
  useDeferredValue,
  useEffect,
  useRef,
  useState,
} from "react";
import { client } from "../../api/client";
import type {
  RelationshipsActivityItem,
  RelationshipsGraphQuery,
  RelationshipsGraphSnapshot,
  RelationshipsMergeCandidate,
  RelationshipsPersonDetail,
  RelationshipsPersonSummary,
} from "../../api/client-types-relationships";
import { useApp } from "../../state";
import { formatDateTime } from "../../utils/format";
import { RelationshipsGraphPanel } from "./RelationshipsGraphPanel";
import { RelationshipsIdentityCluster } from "./RelationshipsIdentityCluster";

const TOOLBAR_BUTTON_BASE =
  "h-8 rounded-full px-3.5 text-2xs font-semibold tracking-[0.12em] border border-border/32 bg-[linear-gradient(180deg,color-mix(in_srgb,var(--card)_84%,transparent),color-mix(in_srgb,var(--bg)_95%,transparent))] text-muted-strong shadow-[inset_0_1px_0_rgba(255,255,255,0.14),0_14px_20px_-18px_rgba(15,23,42,0.14)] backdrop-blur-md transition-[border-color,background-color,color,transform,box-shadow] duration-200 hover:border-border/46 hover:bg-[linear-gradient(180deg,color-mix(in_srgb,var(--card)_90%,transparent),color-mix(in_srgb,var(--bg)_97%,transparent))] hover:text-txt hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.16),0_16px_22px_-18px_rgba(15,23,42,0.16)] active:scale-95 disabled:hover:border-border/32 disabled:hover:bg-[linear-gradient(180deg,color-mix(in_srgb,var(--card)_84%,transparent),color-mix(in_srgb,var(--bg)_95%,transparent))] disabled:hover:text-muted-strong";

function toTimestamp(value?: string): number {
  if (!value) return 0;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function sortPeople(
  people: RelationshipsPersonSummary[],
): RelationshipsPersonSummary[] {
  return [...people].sort((left, right) => {
    if (left.isOwner !== right.isOwner) {
      return left.isOwner ? -1 : 1;
    }
    const timeDiff =
      toTimestamp(right.lastInteractionAt) -
      toTimestamp(left.lastInteractionAt);
    if (timeDiff !== 0) return timeDiff;
    const relationshipDiff = right.relationshipCount - left.relationshipCount;
    if (relationshipDiff !== 0) return relationshipDiff;
    return left.displayName.localeCompare(right.displayName);
  });
}

function summarizeHandles(person: RelationshipsPersonSummary): string {
  const handles = person.identities.flatMap((identity) =>
    identity.handles.map((handle) => `@${handle.handle}`),
  );
  return handles.slice(0, 3).join(", ");
}

function platformOptions(
  snapshot: RelationshipsGraphSnapshot | null,
): string[] {
  if (!snapshot) return [];
  return [...new Set(snapshot.people.flatMap((person) => person.platforms))]
    .filter((platform) => platform.trim().length > 0)
    .sort((left, right) => left.localeCompare(right));
}

function topContacts(person: RelationshipsPersonDetail): Array<{
  label: string;
  value: string;
}> {
  const rows: Array<{ label: string; value: string }> = [];
  if (person.emails[0]) rows.push({ label: "Email", value: person.emails[0] });
  if (person.phones[0]) rows.push({ label: "Phone", value: person.phones[0] });
  if (person.websites[0])
    rows.push({ label: "Website", value: person.websites[0] });
  if (person.preferredCommunicationChannel) {
    rows.push({
      label: "Preferred channel",
      value: person.preferredCommunicationChannel,
    });
  }
  return rows;
}

function profileSourceLabel(source: string): string {
  switch (source) {
    case "client_chat":
      return "App chat";
    case "elizacloud":
      return "Eliza Cloud";
    case "twitter":
      return "X / Twitter";
    default:
      return source
        .replace(/_/g, " ")
        .replace(/\b\w/g, (match) => match.toUpperCase());
  }
}

function profilePrimaryValue(
  person: RelationshipsPersonDetail,
  source: string,
) {
  const profile = person.profiles.find((entry) => entry.source === source);
  if (!profile) {
    return null;
  }
  return (
    profile.displayName ??
    profile.handle ??
    profile.userId ??
    person.displayName
  );
}

function PersonSummaryCard({
  person,
  onViewMemories,
}: {
  person: RelationshipsPersonDetail;
  onViewMemories?: (entityIds: string[]) => void;
}) {
  const contacts = topContacts(person);
  const hasProfiles = person.profiles.length > 0;

  return (
    <PagePanel variant="padded" className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-xs-tight font-semibold uppercase tracking-[0.16em] text-muted/70">
            Canonical person
          </div>
          <div className="mt-2 text-[1.75rem] font-semibold leading-tight text-txt">
            {person.displayName}
          </div>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-muted">
            {person.isOwner
              ? "Canonical owner profile for app chat and linked connectors."
              : person.aliases.length > 0
                ? `Known as ${person.aliases.join(", ")}.`
                : "No alternate aliases have been confirmed yet."}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {person.isOwner ? <MetaPill compact>Owner</MetaPill> : null}
          <MetaPill compact>
            {person.memberEntityIds.length} identities
          </MetaPill>
          <MetaPill compact>{person.factCount} facts</MetaPill>
          <MetaPill compact>{person.relationshipCount} links</MetaPill>
          {onViewMemories ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="ml-1 h-7 rounded-full px-3 text-2xs font-semibold tracking-[0.12em]"
              onClick={() => onViewMemories(person.memberEntityIds)}
            >
              View memories
            </Button>
          ) : null}
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="grid gap-3 sm:grid-cols-2">
          <PagePanel variant="inset" className="px-4 py-4">
            <div className="text-xs-tight uppercase tracking-[0.14em] text-muted/70">
              Platforms
            </div>
            <div className="mt-2 text-sm font-semibold text-txt">
              {person.platforms.join(", ") || "No linked platforms"}
            </div>
          </PagePanel>
          <PagePanel variant="inset" className="px-4 py-4">
            <div className="text-xs-tight uppercase tracking-[0.14em] text-muted/70">
              Last interaction
            </div>
            <div className="mt-2 text-sm font-semibold text-txt">
              {formatDateTime(person.lastInteractionAt, { fallback: "n/a" })}
            </div>
          </PagePanel>
          <PagePanel variant="inset" className="px-4 py-4">
            <div className="text-xs-tight uppercase tracking-[0.14em] text-muted/70">
              Categories
            </div>
            <div className="mt-2 text-sm font-semibold text-txt">
              {person.categories.join(", ") || "No categories"}
            </div>
          </PagePanel>
          <PagePanel variant="inset" className="px-4 py-4">
            <div className="text-xs-tight uppercase tracking-[0.14em] text-muted/70">
              Tags
            </div>
            <div className="mt-2 text-sm font-semibold text-txt">
              {person.tags.join(", ") || "No tags"}
            </div>
          </PagePanel>

          <PagePanel variant="surface" className="sm:col-span-2 px-4 py-4">
            <div className="text-xs-tight uppercase tracking-[0.14em] text-muted/70">
              Reachability
            </div>
            {contacts.length > 0 ? (
              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                {contacts.map((contact) => (
                  <div
                    key={`${contact.label}:${contact.value}`}
                    className="rounded-xl border border-border/24 bg-card/35 px-3 py-3"
                  >
                    <div className="text-2xs font-semibold uppercase tracking-[0.12em] text-muted/70">
                      {contact.label}
                    </div>
                    <div className="mt-1 text-sm font-semibold text-txt">
                      {contact.value}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="mt-3 text-sm leading-6 text-muted">
                No direct contact channels are stored for this person yet.
              </p>
            )}
          </PagePanel>

          {hasProfiles ? (
            <PagePanel variant="surface" className="sm:col-span-2 px-4 py-4">
              <div className="text-xs-tight uppercase tracking-[0.14em] text-muted/70">
                Profiles
              </div>
              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                {person.profiles.map((profile) => (
                  <div
                    key={`${profile.source}:${profile.entityId}`}
                    className="rounded-xl border border-border/24 bg-card/35 px-3 py-3"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <div className="text-2xs font-semibold uppercase tracking-[0.12em] text-muted/70">
                        {profileSourceLabel(profile.source)}
                      </div>
                      {profile.canonical ? (
                        <MetaPill compact>Canonical</MetaPill>
                      ) : null}
                    </div>
                    <div className="mt-1 text-sm font-semibold text-txt">
                      {profilePrimaryValue(person, profile.source) ??
                        "Unknown profile"}
                    </div>
                    <div className="mt-1 text-xs leading-5 text-muted">
                      {profile.handle ? `Handle ${profile.handle}` : null}
                      {profile.handle && profile.userId ? " · " : null}
                      {profile.userId ? `ID ${profile.userId}` : null}
                      {!profile.handle && !profile.userId
                        ? `Entity ${profile.entityId}`
                        : null}
                    </div>
                  </div>
                ))}
              </div>
            </PagePanel>
          ) : null}
        </div>

        <PagePanel variant="surface" className="px-4 py-4">
          <RelationshipsIdentityCluster person={person} />
        </PagePanel>
      </div>
    </PagePanel>
  );
}

function FactsPanel({ person }: { person: RelationshipsPersonDetail }) {
  return (
    <PagePanel variant="surface" className="px-4 py-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-xs-tight font-semibold uppercase tracking-[0.16em] text-muted/70">
            Facts
          </div>
          <div className="mt-2 text-lg font-semibold text-txt">
            Stored claims and memory-backed notes
          </div>
        </div>
        <MetaPill compact>{person.facts.length}</MetaPill>
      </div>

      {person.facts.length === 0 ? (
        <p className="mt-4 text-sm leading-6 text-muted">
          No facts have been extracted for this person yet.
        </p>
      ) : (
        <div className="mt-4 space-y-3">
          {person.facts.map((fact) => {
            const evidenceCount = fact.evidenceMessageIds?.length ?? 0;
            return (
              <div
                key={fact.id}
                className="rounded-2xl border border-border/24 bg-card/32 px-3.5 py-3"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <MetaPill compact>{fact.sourceType}</MetaPill>
                  {fact.field ? (
                    <MetaPill compact>{fact.field}</MetaPill>
                  ) : null}
                  {typeof fact.confidence === "number" ? (
                    <MetaPill compact>
                      {Math.round(fact.confidence * 100)}% confidence
                    </MetaPill>
                  ) : null}
                  {evidenceCount > 0 ? (
                    <MetaPill compact>{evidenceCount} evidence</MetaPill>
                  ) : null}
                </div>
                <div className="mt-2 text-sm leading-6 text-txt">
                  {fact.text}
                </div>
                <div className="mt-2 text-xs text-muted">
                  {fact.lastReinforced
                    ? `Reinforced ${formatDateTime(fact.lastReinforced, { fallback: "n/a" })}`
                    : formatDateTime(fact.updatedAt, {
                        fallback: "No timestamp",
                      })}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </PagePanel>
  );
}

function RelationshipsPanel({ person }: { person: RelationshipsPersonDetail }) {
  return (
    <PagePanel variant="surface" className="px-4 py-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-xs-tight font-semibold uppercase tracking-[0.16em] text-muted/70">
            Relationships
          </div>
          <div className="mt-2 text-lg font-semibold text-txt">
            Strongest adjacent people in the graph
          </div>
        </div>
        <MetaPill compact>{person.relationships.length}</MetaPill>
      </div>

      {person.relationships.length === 0 ? (
        <p className="mt-4 text-sm leading-6 text-muted">
          No cross-person relationship edges have been aggregated for this
          identity group yet.
        </p>
      ) : (
        <div className="mt-4 space-y-3">
          {person.relationships.map((relationship) => {
            const counterpartName =
              relationship.sourcePersonId === person.groupId
                ? relationship.targetPersonName
                : relationship.sourcePersonName;
            return (
              <div
                key={relationship.id}
                className="rounded-2xl border border-border/24 bg-card/32 px-3.5 py-3"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <MetaPill compact>
                    {relationship.strength.toFixed(2)}
                  </MetaPill>
                  <MetaPill compact>{relationship.sentiment}</MetaPill>
                  <MetaPill compact>
                    {relationship.interactionCount} msgs
                  </MetaPill>
                </div>
                <div className="mt-2 text-sm font-semibold text-txt">
                  {counterpartName}
                </div>
                <div className="mt-1 text-xs uppercase tracking-[0.12em] text-muted/70">
                  {relationship.relationshipTypes.join(" • ") || "unknown"}
                </div>
                <div className="mt-2 text-xs text-muted">
                  Last interaction{" "}
                  {formatDateTime(relationship.lastInteractionAt, {
                    fallback: "n/a",
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </PagePanel>
  );
}

function ConversationsPanel({ person }: { person: RelationshipsPersonDetail }) {
  return (
    <PagePanel variant="surface" className="px-4 py-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-xs-tight font-semibold uppercase tracking-[0.16em] text-muted/70">
            Recent conversations
          </div>
          <div className="mt-2 text-lg font-semibold text-txt">
            Latest room snippets linked to this person
          </div>
        </div>
        <MetaPill compact>{person.recentConversations.length}</MetaPill>
      </div>

      {person.recentConversations.length === 0 ? (
        <p className="mt-4 text-sm leading-6 text-muted">
          No recent room snippets are available for this person yet.
        </p>
      ) : (
        <div className="mt-4 grid gap-4 xl:grid-cols-2">
          {person.recentConversations.map((conversation) => (
            <div
              key={conversation.roomId}
              className="rounded-2xl border border-border/24 bg-card/32 px-3.5 py-3"
            >
              <div className="flex items-center justify-between gap-3">
                <div className="text-sm font-semibold text-txt">
                  {conversation.roomName}
                </div>
                <div className="text-xs-tight text-muted">
                  {formatDateTime(conversation.lastActivityAt, {
                    fallback: "n/a",
                  })}
                </div>
              </div>

              <div className="mt-3 space-y-2">
                {conversation.messages.map((message) => (
                  <div
                    key={message.id}
                    className="rounded-xl bg-card/50 px-3 py-2.5"
                  >
                    <div className="text-xs-tight font-semibold uppercase tracking-[0.12em] text-muted/70">
                      {message.speaker}
                    </div>
                    <div className="mt-1 text-sm leading-6 text-txt">
                      {message.text}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </PagePanel>
  );
}

const ACTIVITY_TYPE_COLORS: Record<string, { bg: string; fg: string }> = {
  relationship: { bg: "rgba(99, 102, 241, 0.15)", fg: "rgb(99, 102, 241)" },
  fact: { bg: "rgba(34, 197, 94, 0.15)", fg: "rgb(34, 197, 94)" },
  identity: { bg: "rgba(168, 85, 247, 0.15)", fg: "rgb(168, 85, 247)" },
};

function RelationshipsActivityFeed() {
  const [activity, setActivity] = useState<RelationshipsActivityItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    void client
      .getRelationshipsActivity(50)
      .then((resp) => setActivity(resp.activity))
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

function personLabel(
  graph: RelationshipsGraphSnapshot | null,
  entityId: string,
): string {
  if (!graph) return entityId;
  for (const person of graph.people) {
    if (person.memberEntityIds.includes(entityId)) {
      return person.displayName;
    }
  }
  return entityId;
}

function evidenceSummary(candidate: RelationshipsMergeCandidate): string {
  const parts: string[] = [];
  const platform =
    typeof candidate.evidence.platform === "string"
      ? candidate.evidence.platform
      : null;
  const handle =
    typeof candidate.evidence.handle === "string"
      ? candidate.evidence.handle
      : null;
  if (platform && handle) {
    parts.push(`${platform}:${handle}`);
  } else if (platform) {
    parts.push(platform);
  }
  const notes =
    typeof candidate.evidence.notes === "string"
      ? candidate.evidence.notes
      : null;
  if (notes) parts.push(notes);
  const ids = candidate.evidence.identityIds;
  if (Array.isArray(ids) && ids.length > 0) {
    parts.push(`${ids.length} identity refs`);
  }
  return parts.join(" · ") || "no evidence summary";
}

function CandidateMergesPanel({
  graph,
  onResolved,
}: {
  graph: RelationshipsGraphSnapshot;
  onResolved: () => void;
}) {
  const [pending, setPending] = useState<Set<string>>(new Set());
  const [errors, setErrors] = useState<Map<string, string>>(new Map());
  const candidates = graph.candidateMerges ?? [];

  if (candidates.length === 0) {
    return null;
  }

  const setError = (id: string, message: string | null) => {
    setErrors((prev) => {
      const next = new Map(prev);
      if (message === null) {
        next.delete(id);
      } else {
        next.set(id, message);
      }
      return next;
    });
  };

  const setPendingState = (id: string, isPending: boolean) => {
    setPending((prev) => {
      const next = new Set(prev);
      if (isPending) {
        next.add(id);
      } else {
        next.delete(id);
      }
      return next;
    });
  };

  const onAccept = async (candidate: RelationshipsMergeCandidate) => {
    setPendingState(candidate.id, true);
    setError(candidate.id, null);
    try {
      await client.acceptRelationshipsCandidate(candidate.id);
      onResolved();
    } catch (err) {
      setError(
        candidate.id,
        err instanceof Error ? err.message : "Failed to accept merge.",
      );
    } finally {
      setPendingState(candidate.id, false);
    }
  };

  const onReject = async (candidate: RelationshipsMergeCandidate) => {
    setPendingState(candidate.id, true);
    setError(candidate.id, null);
    try {
      await client.rejectRelationshipsCandidate(candidate.id);
      onResolved();
    } catch (err) {
      setError(
        candidate.id,
        err instanceof Error ? err.message : "Failed to reject merge.",
      );
    } finally {
      setPendingState(candidate.id, false);
    }
  };

  return (
    <PagePanel variant="surface" className="px-4 py-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-xs-tight font-semibold uppercase tracking-[0.16em] text-muted/70">
            Identity merges
          </div>
          <div className="mt-2 text-lg font-semibold text-txt">
            Pending merge proposals
          </div>
          <p className="mt-1 text-xs text-muted">
            Two entities look like the same person. Accept to fold them, reject
            to leave them separate.
          </p>
        </div>
        <MetaPill compact>{candidates.length}</MetaPill>
      </div>

      <div className="mt-4 space-y-3">
        {candidates.map((candidate) => {
          const isPending = pending.has(candidate.id);
          const errorMessage = errors.get(candidate.id) ?? null;
          const evidenceCount = Array.isArray(candidate.evidence.identityIds)
            ? candidate.evidence.identityIds.length
            : 0;
          return (
            <div
              key={candidate.id}
              className="rounded-2xl border border-border/24 bg-card/32 px-3.5 py-3"
            >
              <div className="flex flex-wrap items-center gap-2">
                <MetaPill compact>
                  {Math.round(candidate.confidence * 100)}% confidence
                </MetaPill>
                <MetaPill compact>{evidenceCount} evidence</MetaPill>
                <MetaPill compact>
                  {formatDateTime(candidate.proposedAt, { fallback: "n/a" })}
                </MetaPill>
              </div>
              <div className="mt-2 text-sm font-semibold text-txt">
                {personLabel(graph, candidate.entityA)}{" "}
                <span className="text-muted">↔</span>{" "}
                {personLabel(graph, candidate.entityB)}
              </div>
              <div className="mt-1 text-xs leading-5 text-muted">
                {evidenceSummary(candidate)}
              </div>
              {errorMessage ? (
                <div className="mt-2 text-xs text-danger">{errorMessage}</div>
              ) : null}
              <div className="mt-3 flex flex-wrap gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="default"
                  disabled={isPending}
                  onClick={() => {
                    void onAccept(candidate);
                  }}
                >
                  {isPending ? "Working…" : "Accept merge"}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={isPending}
                  onClick={() => {
                    void onReject(candidate);
                  }}
                >
                  Reject
                </Button>
              </div>
            </div>
          );
        })}
      </div>
    </PagePanel>
  );
}

export function RelationshipsView({
  contentHeader,
}: {
  contentHeader?: ReactNode;
} = {}) {
  const { t, setTab } = useApp();
  const [search, setSearch] = useState("");
  const [platform, setPlatform] = useState<string>("all");
  const [graphLoading, setGraphLoading] = useState(true);
  const [graphError, setGraphError] = useState<string | null>(null);
  const [graph, setGraph] = useState<RelationshipsGraphSnapshot | null>(null);
  const [selectedPersonId, setSelectedPersonId] = useState<string | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detail, setDetail] = useState<RelationshipsPersonDetail | null>(null);
  // Keep previous detail visible while loading a new person (optimistic transition).
  const prevDetail = useRef<RelationshipsPersonDetail | null>(null);
  const deferredSearch = useDeferredValue(search);

  const loadGraph = useCallback(async (query: RelationshipsGraphQuery) => {
    setGraphLoading(true);
    setGraphError(null);

    try {
      const snapshot = await client.getRelationshipsGraph(query);
      const nextGraph = {
        ...snapshot,
        people: sortPeople(snapshot.people),
      };
      setGraph(nextGraph);
    } catch (error) {
      setGraphError(
        error instanceof Error
          ? error.message
          : "Failed to load the relationships graph.",
      );
      setGraph(null);
    } finally {
      setGraphLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadGraph({
      search: deferredSearch.trim() || undefined,
      platform: platform === "all" ? undefined : platform,
      limit: 200,
    });
  }, [deferredSearch, platform, loadGraph]);

  useEffect(() => {
    if (!graph || graph.people.length === 0) {
      setSelectedPersonId(null);
      setDetail(null);
      return;
    }

    const stillSelected = graph.people.some(
      (person) => person.primaryEntityId === selectedPersonId,
    );
    if (!stillSelected) {
      setSelectedPersonId(graph.people[0]?.primaryEntityId ?? null);
    }
  }, [graph, selectedPersonId]);

  // Keep a live ref to `detail` so the effect can snapshot it without
  // adding it to the dependency array (which would re-trigger the fetch).
  const detailRef = useRef(detail);
  detailRef.current = detail;

  useEffect(() => {
    if (!selectedPersonId) {
      prevDetail.current = null;
      setDetail(null);
      return;
    }

    let cancelled = false;
    // Stash the current detail so we can keep showing it during load.
    if (detailRef.current) {
      prevDetail.current = detailRef.current;
    }
    setDetailLoading(true);
    setDetailError(null);

    void client
      .getRelationshipsPerson(selectedPersonId)
      .then((person) => {
        if (!cancelled) {
          setDetail(person);
          prevDetail.current = null;
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setDetail(null);
          prevDetail.current = null;
          setDetailError(
            err instanceof Error
              ? err.message
              : "Failed to load the selected person.",
          );
        }
      })
      .finally(() => {
        if (!cancelled) {
          setDetailLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [selectedPersonId]);

  const platforms = platformOptions(graph);
  const selectedSummary =
    graph?.people.find(
      (person) => person.primaryEntityId === selectedPersonId,
    ) ?? null;
  const selectedGroupId = selectedSummary?.groupId ?? null;
  // Show the previous person while the new one loads (optimistic transition).
  const displayDetail = detail ?? (detailLoading ? prevDetail.current : null);
  const isStaleDetail = detailLoading && !detail && prevDetail.current !== null;

  const sidebar = (
    <Sidebar testId="relationships-sidebar">
      <SidebarHeader
        search={{
          value: search,
          onChange: (event) => setSearch(event.target.value),
          placeholder: "Search people, aliases, handles",
          "aria-label": "Search people, aliases, handles",
          onClear: () => setSearch(""),
        }}
      />
      <SidebarPanel>
        <PagePanel.SummaryCard compact className="mt-2 space-y-3">
          <div className="grid grid-cols-3 gap-2">
            <div className="rounded-xl border border-border/24 bg-card/35 px-2.5 py-2">
              <div className="text-2xs uppercase tracking-[0.12em] text-muted/70">
                People
              </div>
              <div className="mt-1 text-sm font-semibold text-txt">
                {graph?.stats.totalPeople ?? 0}
              </div>
            </div>
            <div className="rounded-xl border border-border/24 bg-card/35 px-2.5 py-2">
              <div className="text-2xs uppercase tracking-[0.12em] text-muted/70">
                Links
              </div>
              <div className="mt-1 text-sm font-semibold text-txt">
                {graph?.stats.totalRelationships ?? 0}
              </div>
            </div>
            <div className="rounded-xl border border-border/24 bg-card/35 px-2.5 py-2">
              <div className="text-2xs uppercase tracking-[0.12em] text-muted/70">
                IDs
              </div>
              <div className="mt-1 text-sm font-semibold text-txt">
                {graph?.stats.totalIdentities ?? 0}
              </div>
            </div>
          </div>

          <div>
            <div className="text-xs-tight font-semibold uppercase tracking-[0.14em] text-muted/70">
              Platform filter
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              <Button
                type="button"
                size="sm"
                variant="outline"
                className={`${TOOLBAR_BUTTON_BASE} ${platform === "all" ? "border-accent/40 bg-accent/14 text-txt" : ""}`}
                onClick={() => setPlatform("all")}
              >
                All
              </Button>
              {platforms.map((entry) => (
                <Button
                  key={entry}
                  type="button"
                  size="sm"
                  variant="outline"
                  className={`${TOOLBAR_BUTTON_BASE} ${platform === entry ? "border-accent/40 bg-accent/14 text-txt" : ""}`}
                  onClick={() => setPlatform(entry)}
                >
                  {entry}
                </Button>
              ))}
            </div>
          </div>

          <Button
            type="button"
            size="sm"
            variant="outline"
            className={TOOLBAR_BUTTON_BASE}
            onClick={() =>
              void loadGraph({
                search: deferredSearch.trim() || undefined,
                platform: platform === "all" ? undefined : platform,
                limit: 200,
              })
            }
          >
            {graphLoading ? "Refreshing…" : "Refresh graph"}
          </Button>
        </PagePanel.SummaryCard>

        <SidebarContent.SectionLabel className="mt-3">
          People
        </SidebarContent.SectionLabel>
        <SidebarScrollRegion className="mt-2">
          <div className="space-y-1.5">
            {graph?.people.map((person) => {
              const active = person.primaryEntityId === selectedPersonId;
              return (
                <SidebarContent.Item
                  key={person.groupId}
                  active={active}
                  onClick={() => setSelectedPersonId(person.primaryEntityId)}
                  aria-current={active ? "page" : undefined}
                >
                  <SidebarContent.ItemIcon active={active}>
                    {person.displayName.charAt(0).toUpperCase()}
                  </SidebarContent.ItemIcon>
                  <span className="min-w-0 flex-1 text-left">
                    <SidebarContent.ItemTitle>
                      {person.displayName}
                    </SidebarContent.ItemTitle>
                    <SidebarContent.ItemDescription>
                      {person.isOwner
                        ? `Owner · ${summarizeHandles(person) || person.platforms.join(" • ") || "Canonical profile"}`
                        : summarizeHandles(person) ||
                          person.platforms.join(" • ") ||
                          "No handles yet"}
                    </SidebarContent.ItemDescription>
                  </span>
                  <MetaPill compact>{person.memberEntityIds.length}</MetaPill>
                </SidebarContent.Item>
              );
            })}
          </div>
        </SidebarScrollRegion>
      </SidebarPanel>
    </Sidebar>
  );

  return (
    <PageLayout
      sidebar={sidebar}
      contentHeader={contentHeader}
      data-testid="relationships-view"
    >
      <div className="flex min-h-0 flex-1 flex-col gap-4">
        {graphError ? (
          <div className="rounded-2xl border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger">
            {graphError}
          </div>
        ) : null}
        {detailError ? (
          <div className="rounded-2xl border border-warning/30 bg-warning/10 px-4 py-3 text-sm text-warning">
            {detailError}
          </div>
        ) : null}

        {!graph && graphLoading ? (
          <PagePanel.Loading
            heading={t("common.loading", { defaultValue: "Loading…" })}
          />
        ) : !graph || graph.people.length === 0 ? (
          <PagePanel.Empty
            variant="panel"
            className="min-h-[24rem]"
            description="Connectors, relationships extraction, and confirmed identity links will populate this workspace."
            title="No relationships data available"
          />
        ) : (
          <>
            <div className="grid gap-4 xl:grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)]">
              <PagePanel variant="surface" className="px-4 py-4">
                <RelationshipsGraphPanel
                  snapshot={graph}
                  selectedGroupId={selectedGroupId}
                  onSelectGroupId={(groupId) => {
                    const person = graph.people.find(
                      (entry) => entry.groupId === groupId,
                    );
                    if (person) {
                      setSelectedPersonId(person.primaryEntityId);
                    }
                  }}
                />
              </PagePanel>

              {displayDetail ? (
                <div
                  className={
                    isStaleDetail
                      ? "pointer-events-none opacity-50 transition-opacity duration-200"
                      : "transition-opacity duration-200"
                  }
                >
                  <PersonSummaryCard
                    person={displayDetail}
                    onViewMemories={() => setTab("memories")}
                  />
                </div>
              ) : detailLoading ? (
                <PagePanel.Loading heading="Loading person detail…" />
              ) : (
                <PagePanel.Empty
                  variant="panel"
                  title="Select a person"
                  description="Choose a person in the left rail or graph to inspect linked identities, facts, and conversation snippets."
                />
              )}
            </div>

            {displayDetail ? (
              <div
                className={`grid gap-4 xl:grid-cols-2 ${isStaleDetail ? "pointer-events-none opacity-50 transition-opacity duration-200" : "transition-opacity duration-200"}`}
              >
                <FactsPanel person={displayDetail} />
                <RelationshipsPanel person={displayDetail} />
                <div className="xl:col-span-2">
                  <ConversationsPanel person={displayDetail} />
                </div>
              </div>
            ) : null}

            {graph ? (
              <CandidateMergesPanel
                graph={graph}
                onResolved={() => {
                  void loadGraph({
                    search: deferredSearch.trim() || undefined,
                    platform: platform === "all" ? undefined : platform,
                    limit: 200,
                  });
                }}
              />
            ) : null}

            {/* Relationship activity feed */}
            <PagePanel variant="surface" className="px-4 py-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-xs-tight font-semibold uppercase tracking-[0.16em] text-muted/70">
                    Activity feed
                  </div>
                  <div className="mt-2 text-lg font-semibold text-txt">
                    Recent relationship, identity, and fact events
                  </div>
                </div>
              </div>
              <div className="mt-4">
                <RelationshipsActivityFeed />
              </div>
            </PagePanel>
          </>
        )}
      </div>
    </PageLayout>
  );
}
