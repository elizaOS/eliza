import { Button, MetaPill, PagePanel } from "@elizaos/ui";
import type {
  RelationshipsGraphEdge,
  RelationshipsPersonDetail,
  RelationshipsProfile,
} from "../../../api/client-types-relationships";
import { formatDateTime } from "../../../utils/format";
import { RelationshipsIdentityCluster } from "../RelationshipsIdentityCluster";
import {
  buildAdditionalHighlights,
  profilePrimaryValue,
  profileSourceLabel,
  type RelationshipsPersonSupplementalDetail,
  topContacts,
} from "./relationships-utils";

type RelationshipsDisplayPerson = RelationshipsPersonDetail &
  RelationshipsPersonSupplementalDetail;

function resolvePrimaryAvatar(
  person: RelationshipsDisplayPerson,
): string | null {
  for (const profile of person.profiles) {
    if (profile.avatarUrl?.trim()) {
      return profile.avatarUrl;
    }
  }
  return null;
}

function listValue(values: string[], fallback: string): string {
  return values.length > 0 ? values.join(", ") : fallback;
}

function personSummary(person: RelationshipsDisplayPerson): string {
  if (person.headline?.trim()) {
    return person.headline.trim();
  }
  if (person.bio?.trim()) {
    return person.bio.trim();
  }
  if (person.notes?.trim()) {
    return person.notes.trim();
  }
  if (person.isOwner) {
    return "Canonical owner profile for app chat and linked connectors.";
  }
  if (person.aliases.length > 0) {
    return `Known as ${person.aliases.join(", ")}.`;
  }
  return "No alternate aliases have been confirmed yet.";
}

function relationshipCounterpartName(
  relationship: RelationshipsGraphEdge,
  groupId: string,
): string {
  return relationship.sourcePersonId === groupId
    ? relationship.targetPersonName
    : relationship.sourcePersonName;
}

function ProfileCard({
  person,
  profile,
}: {
  person: RelationshipsDisplayPerson;
  profile: RelationshipsProfile;
}) {
  const primaryValue =
    profilePrimaryValue(person, profile.source) ?? "Unknown profile";

  return (
    <div className="rounded-xl border border-border/24 bg-card/35 px-3 py-3">
      <div className="flex items-start gap-3">
        {profile.avatarUrl ? (
          <img
            src={profile.avatarUrl}
            alt=""
            className="mt-0.5 h-10 w-10 rounded-full border border-border/24 object-cover"
          />
        ) : null}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <div className="text-2xs font-semibold uppercase tracking-[0.12em] text-muted/70">
              {profileSourceLabel(profile.source)}
            </div>
            {profile.canonical ? <MetaPill compact>Canonical</MetaPill> : null}
          </div>
          <div className="mt-1 text-sm font-semibold text-txt">
            {primaryValue}
          </div>
          <div className="mt-1 text-xs leading-5 text-muted">
            {profile.handle ? `Handle ${profile.handle}` : null}
            {profile.handle && profile.userId ? " · " : null}
            {profile.userId ? `ID ${profile.userId}` : null}
            {!profile.handle && !profile.userId
              ? `Entity ${profile.entityId}`
              : null}
          </div>
          {profile.displayName && profile.displayName !== primaryValue ? (
            <div className="mt-1 text-xs leading-5 text-muted">
              Profile name {profile.displayName}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export function RelationshipsPersonSummaryPanel({
  person,
  onViewMemories,
}: {
  person: RelationshipsDisplayPerson;
  onViewMemories?: (entityIds: string[]) => void;
}) {
  const avatarUrl = resolvePrimaryAvatar(person);
  const contacts = topContacts(person);
  const hasProfiles = person.profiles.length > 0;
  const additionalHighlights = buildAdditionalHighlights(person);

  return (
    <PagePanel variant="padded" className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-4">
          {avatarUrl ? (
            <img
              src={avatarUrl}
              alt=""
              className="hidden h-16 w-16 rounded-2xl border border-border/24 object-cover shadow-sm sm:block"
            />
          ) : null}
          <div>
            <div className="text-xs-tight font-semibold uppercase tracking-[0.16em] text-muted/70">
              Canonical person
            </div>
            <div className="mt-2 text-[1.75rem] font-semibold leading-tight text-txt">
              {person.displayName}
            </div>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-muted">
              {personSummary(person)}
            </p>
          </div>
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
              {listValue(person.platforms, "No linked platforms")}
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
              {listValue(person.categories, "No categories")}
            </div>
          </PagePanel>
          <PagePanel variant="inset" className="px-4 py-4">
            <div className="text-xs-tight uppercase tracking-[0.14em] text-muted/70">
              Tags
            </div>
            <div className="mt-2 text-sm font-semibold text-txt">
              {listValue(person.tags, "No tags")}
            </div>
          </PagePanel>

          {additionalHighlights.length > 0 ? (
            <PagePanel variant="surface" className="sm:col-span-2 px-4 py-4">
              <div className="text-xs-tight uppercase tracking-[0.14em] text-muted/70">
                Additional context
              </div>
              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                {additionalHighlights.map((row) => (
                  <div
                    key={`${row.label}:${row.value}`}
                    className="rounded-xl border border-border/24 bg-card/35 px-3 py-3"
                  >
                    <div className="text-2xs font-semibold uppercase tracking-[0.12em] text-muted/70">
                      {row.label}
                    </div>
                    <div className="mt-1 text-sm font-semibold text-txt">
                      {row.value}
                    </div>
                  </div>
                ))}
              </div>
            </PagePanel>
          ) : null}

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
                  <ProfileCard
                    key={`${profile.source}:${profile.entityId}`}
                    person={person}
                    profile={profile}
                  />
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

export function RelationshipsFactsPanel({
  person,
}: {
  person: RelationshipsDisplayPerson;
}) {
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
                  {fact.extractedInformation?.scope ? (
                    <MetaPill compact>
                      {fact.extractedInformation.scope}
                    </MetaPill>
                  ) : null}
                  {typeof fact.confidence === "number" ? (
                    <MetaPill compact>
                      {Math.round(fact.confidence * 100)}% confidence
                    </MetaPill>
                  ) : null}
                  {fact.provenance?.evaluatorName ? (
                    <MetaPill compact>{fact.provenance.evaluatorName}</MetaPill>
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
                {fact.provenance?.source ||
                fact.provenance?.sourceTrajectoryId ? (
                  <div className="mt-2 text-xs leading-5 text-muted">
                    {fact.provenance?.source
                      ? `Source ${fact.provenance.source}`
                      : null}
                    {fact.provenance?.source &&
                    fact.provenance?.sourceTrajectoryId
                      ? " · "
                      : null}
                    {fact.provenance?.sourceTrajectoryId
                      ? `Trajectory ${fact.provenance.sourceTrajectoryId}`
                      : null}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </PagePanel>
  );
}

export function RelationshipsConnectionsPanel({
  person,
}: {
  person: RelationshipsDisplayPerson;
}) {
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
          {person.relationships.map((relationship) => (
            <div
              key={relationship.id}
              className="rounded-2xl border border-border/24 bg-card/32 px-3.5 py-3"
            >
              <div className="flex flex-wrap items-center gap-2">
                <MetaPill compact>{relationship.strength.toFixed(2)}</MetaPill>
                <MetaPill compact>{relationship.sentiment}</MetaPill>
                <MetaPill compact>
                  {relationship.interactionCount} msgs
                </MetaPill>
              </div>
              <div className="mt-2 text-sm font-semibold text-txt">
                {relationshipCounterpartName(relationship, person.groupId)}
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
          ))}
        </div>
      )}
    </PagePanel>
  );
}

export function RelationshipsConversationsPanel({
  person,
}: {
  person: RelationshipsDisplayPerson;
}) {
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

export function RelationshipsRelevantMemoriesPanel({
  person,
}: {
  person: RelationshipsDisplayPerson;
}) {
  return (
    <PagePanel variant="surface" className="px-4 py-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-xs-tight font-semibold uppercase tracking-[0.16em] text-muted/70">
            Relevant memories
          </div>
          <div className="mt-2 text-lg font-semibold text-txt">
            Message memories tied to this person
          </div>
        </div>
        <MetaPill compact>{person.relevantMemories.length}</MetaPill>
      </div>

      {person.relevantMemories.length === 0 ? (
        <p className="mt-4 text-sm leading-6 text-muted">
          No relevant memories are attached to this person yet.
        </p>
      ) : (
        <div className="mt-4 space-y-3">
          {person.relevantMemories.map((memory) => (
            <div
              key={memory.id}
              className="rounded-2xl border border-border/24 bg-card/32 px-3.5 py-3"
            >
              <div className="flex flex-wrap items-center gap-2">
                <MetaPill compact>{memory.sourceType}</MetaPill>
                {memory.source ? (
                  <MetaPill compact>{memory.source}</MetaPill>
                ) : null}
                {memory.roomName ? (
                  <MetaPill compact>{memory.roomName}</MetaPill>
                ) : null}
              </div>
              <div className="mt-2 text-xs-tight font-semibold uppercase tracking-[0.12em] text-muted/70">
                {memory.speaker}
              </div>
              <div className="mt-1 text-sm leading-6 text-txt">
                {memory.text}
              </div>
              <div className="mt-2 text-xs text-muted">
                {formatDateTime(memory.createdAt, { fallback: "No timestamp" })}
              </div>
            </div>
          ))}
        </div>
      )}
    </PagePanel>
  );
}

export function RelationshipsUserPreferencesPanel({
  person,
}: {
  person: RelationshipsDisplayPerson;
}) {
  return (
    <PagePanel variant="surface" className="px-4 py-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-xs-tight font-semibold uppercase tracking-[0.16em] text-muted/70">
            User personality preferences
          </div>
          <div className="mt-2 text-lg font-semibold text-txt">
            User-scoped guidance learned from interactions
          </div>
        </div>
        <MetaPill compact>{person.userPersonalityPreferences.length}</MetaPill>
      </div>

      {person.userPersonalityPreferences.length === 0 ? (
        <p className="mt-4 text-sm leading-6 text-muted">
          No user-scoped personality preferences have been learned for this
          person yet.
        </p>
      ) : (
        <div className="mt-4 space-y-3">
          {person.userPersonalityPreferences.map((preference) => (
            <div
              key={preference.id}
              className="rounded-2xl border border-border/24 bg-card/32 px-3.5 py-3"
            >
              <div className="flex flex-wrap items-center gap-2">
                <MetaPill compact>
                  {preference.category ?? "preference"}
                </MetaPill>
                {preference.source ? (
                  <MetaPill compact>{preference.source}</MetaPill>
                ) : null}
              </div>
              <div className="mt-2 text-sm leading-6 text-txt">
                {preference.text}
              </div>
              {preference.originalRequest ? (
                <div className="mt-2 text-xs leading-5 text-muted">
                  Request: {preference.originalRequest}
                </div>
              ) : null}
              <div className="mt-2 text-xs text-muted">
                {formatDateTime(preference.createdAt, {
                  fallback: "No timestamp",
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </PagePanel>
  );
}
