import { Button, MetaPill, PagePanel } from "@elizaos/ui";
import type { ReactNode } from "react";
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

const PANEL_PREVIEW_LIMIT = 4;
const CONVERSATION_PREVIEW_LIMIT = 2;
const MESSAGE_PREVIEW_LIMIT = 3;
const TEXT_PREVIEW_LENGTH = 420;

function boundedText(value: string, maxLength = TEXT_PREVIEW_LENGTH): string {
  const trimmed = value.trim();
  return trimmed.length > maxLength
    ? `${trimmed.slice(0, maxLength - 1)}...`
    : trimmed;
}

function visibleItems<T>(items: T[], limit = PANEL_PREVIEW_LIMIT): T[] {
  return items.slice(0, limit);
}

function overflowCount(items: unknown[], limit = PANEL_PREVIEW_LIMIT): number {
  return Math.max(0, items.length - limit);
}

function MoreItems({
  count,
  children,
}: {
  count: number;
  children: ReactNode;
}) {
  if (count <= 0) return null;

  return (
    <details className="mt-3 rounded-xl border border-border/24 bg-card/24 px-3 py-2">
      <summary className="cursor-pointer text-xs-tight font-semibold text-muted transition hover:text-txt">
        Show {count} more
      </summary>
      <div className="mt-3 space-y-3">{children}</div>
    </details>
  );
}

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
  const secondary =
    profile.handle ??
    (profile.displayName && profile.displayName !== primaryValue
      ? profile.displayName
      : null);

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
          {secondary ? (
            <div className="mt-1 text-xs leading-5 text-muted">
              {profile.handle ? `Handle ${secondary}` : `Profile ${secondary}`}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export function RelationshipsPersonSummaryPanel({
  person,
  compact = false,
  onViewMemories,
}: {
  person: RelationshipsDisplayPerson;
  compact?: boolean;
  onViewMemories?: (entityIds: string[]) => void;
}) {
  const avatarUrl = resolvePrimaryAvatar(person);
  const contacts = topContacts(person);
  const hasProfiles = person.profiles.length > 0;
  const additionalHighlights = buildAdditionalHighlights(person);

  return (
    <PagePanel variant="padded" className={compact ? "space-y-3" : "space-y-4"}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          {avatarUrl ? (
            <img
              src={avatarUrl}
              alt=""
              className={`${compact ? "h-12 w-12 rounded-xl" : "h-16 w-16 rounded-2xl"} hidden border border-border/24 object-cover shadow-sm sm:block`}
            />
          ) : null}
          <div className="min-w-0">
            <div className="text-xs-tight font-semibold uppercase tracking-[0.16em] text-muted/70">
              Canonical person
            </div>
            <div
              className={`${compact ? "mt-1 text-xl" : "mt-2 text-[1.75rem]"} break-words font-semibold leading-tight text-txt`}
            >
              {person.displayName}
            </div>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-muted">
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

      <div
        className={
          compact
            ? "space-y-3"
            : "grid gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]"
        }
      >
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

          {hasProfiles && !compact ? <ProfilesPanel person={person} /> : null}
        </div>

        {compact ? (
          <details className="rounded-xl border border-border/24 bg-card/24 px-3 py-2">
            <summary className="cursor-pointer text-xs-tight font-semibold text-muted transition hover:text-txt">
              Profiles and identity cluster
            </summary>
            <div className="mt-3 space-y-3">
              {hasProfiles ? <ProfilesPanel person={person} /> : null}
              <PagePanel variant="surface" className="px-4 py-4">
                <RelationshipsIdentityCluster person={person} />
              </PagePanel>
            </div>
          </details>
        ) : (
          <PagePanel variant="surface" className="px-4 py-4">
            <RelationshipsIdentityCluster person={person} />
          </PagePanel>
        )}
      </div>
    </PagePanel>
  );
}

function ProfilesPanel({ person }: { person: RelationshipsDisplayPerson }) {
  return (
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
  );
}

export function RelationshipsFactsPanel({
  person,
}: {
  person: RelationshipsDisplayPerson;
}) {
  const shownFacts = visibleItems(person.facts);
  const hiddenFacts = person.facts.slice(PANEL_PREVIEW_LIMIT);

  const renderFact = (fact: (typeof person.facts)[number]) => {
    const evidenceCount = fact.evidenceMessageIds?.length ?? 0;
    return (
      <div
        key={fact.id}
        className="rounded-xl border border-border/24 bg-card/32 px-3.5 py-3"
      >
        <div className="flex flex-wrap items-center gap-2">
          <MetaPill compact>{fact.sourceType}</MetaPill>
          {fact.field ? <MetaPill compact>{fact.field}</MetaPill> : null}
          {fact.extractedInformation?.scope ? (
            <MetaPill compact>{fact.extractedInformation.scope}</MetaPill>
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
          {boundedText(fact.text)}
        </div>
        <div className="mt-2 text-xs text-muted">
          {fact.lastReinforced
            ? `Reinforced ${formatDateTime(fact.lastReinforced, { fallback: "n/a" })}`
            : formatDateTime(fact.updatedAt, {
                fallback: "No timestamp",
              })}
        </div>
        {fact.provenance?.source ? (
          <div className="mt-2 text-xs leading-5 text-muted">
            Source {fact.provenance.source}
          </div>
        ) : null}
      </div>
    );
  };

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
          {shownFacts.map(renderFact)}
          <MoreItems count={overflowCount(person.facts)}>
            {hiddenFacts.map(renderFact)}
          </MoreItems>
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
  const shownRelationships = visibleItems(person.relationships);
  const hiddenRelationships = person.relationships.slice(PANEL_PREVIEW_LIMIT);
  const renderRelationship = (
    relationship: (typeof person.relationships)[number],
  ) => (
    <div
      key={relationship.id}
      className="rounded-xl border border-border/24 bg-card/32 px-3.5 py-3"
    >
      <div className="flex flex-wrap items-center gap-2">
        <MetaPill compact>{relationship.strength.toFixed(2)}</MetaPill>
        <MetaPill compact>{relationship.sentiment}</MetaPill>
        <MetaPill compact>{relationship.interactionCount} msgs</MetaPill>
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
  );

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
          {shownRelationships.map(renderRelationship)}
          <MoreItems count={overflowCount(person.relationships)}>
            {hiddenRelationships.map(renderRelationship)}
          </MoreItems>
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
  const shownConversations = visibleItems(
    person.recentConversations,
    CONVERSATION_PREVIEW_LIMIT,
  );
  const hiddenConversations = person.recentConversations.slice(
    CONVERSATION_PREVIEW_LIMIT,
  );
  const renderConversation = (
    conversation: (typeof person.recentConversations)[number],
  ) => (
    <div
      key={conversation.roomId}
      className="rounded-xl border border-border/24 bg-card/32 px-3.5 py-3"
    >
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0 truncate text-sm font-semibold text-txt">
          {conversation.roomName}
        </div>
        <div className="shrink-0 text-xs-tight text-muted">
          {formatDateTime(conversation.lastActivityAt, {
            fallback: "n/a",
          })}
        </div>
      </div>

      <div className="mt-3 space-y-2">
        {conversation.messages
          .slice(0, MESSAGE_PREVIEW_LIMIT)
          .map((message) => (
            <div key={message.id} className="rounded-xl bg-card/50 px-3 py-2.5">
              <div className="text-xs-tight font-semibold uppercase tracking-[0.12em] text-muted/70">
                {message.speaker}
              </div>
              <div className="mt-1 text-sm leading-6 text-txt">
                {boundedText(message.text, 300)}
              </div>
            </div>
          ))}
        {conversation.messages.length > MESSAGE_PREVIEW_LIMIT ? (
          <div className="text-xs-tight text-muted">
            {conversation.messages.length - MESSAGE_PREVIEW_LIMIT} older
            messages hidden
          </div>
        ) : null}
      </div>
    </div>
  );

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
          {shownConversations.map(renderConversation)}
          <div className="xl:col-span-2">
            <MoreItems
              count={overflowCount(
                person.recentConversations,
                CONVERSATION_PREVIEW_LIMIT,
              )}
            >
              <div className="grid gap-4 xl:grid-cols-2">
                {hiddenConversations.map(renderConversation)}
              </div>
            </MoreItems>
          </div>
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
  const shownMemories = visibleItems(person.relevantMemories);
  const hiddenMemories = person.relevantMemories.slice(PANEL_PREVIEW_LIMIT);
  const renderMemory = (memory: (typeof person.relevantMemories)[number]) => (
    <div
      key={memory.id}
      className="rounded-xl border border-border/24 bg-card/32 px-3.5 py-3"
    >
      <div className="flex flex-wrap items-center gap-2">
        <MetaPill compact>{memory.sourceType}</MetaPill>
        {memory.source ? <MetaPill compact>{memory.source}</MetaPill> : null}
        {memory.roomName ? (
          <MetaPill compact>{memory.roomName}</MetaPill>
        ) : null}
      </div>
      <div className="mt-2 text-xs-tight font-semibold uppercase tracking-[0.12em] text-muted/70">
        {memory.speaker}
      </div>
      <div className="mt-1 text-sm leading-6 text-txt">
        {boundedText(memory.text)}
      </div>
      <div className="mt-2 text-xs text-muted">
        {formatDateTime(memory.createdAt, { fallback: "No timestamp" })}
      </div>
    </div>
  );

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
          {shownMemories.map(renderMemory)}
          <MoreItems count={overflowCount(person.relevantMemories)}>
            {hiddenMemories.map(renderMemory)}
          </MoreItems>
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
  const shownPreferences = visibleItems(person.userPersonalityPreferences);
  const hiddenPreferences =
    person.userPersonalityPreferences.slice(PANEL_PREVIEW_LIMIT);
  const renderPreference = (
    preference: (typeof person.userPersonalityPreferences)[number],
  ) => (
    <div
      key={preference.id}
      className="rounded-xl border border-border/24 bg-card/32 px-3.5 py-3"
    >
      <div className="flex flex-wrap items-center gap-2">
        <MetaPill compact>{preference.category ?? "preference"}</MetaPill>
        {preference.source ? (
          <MetaPill compact>{preference.source}</MetaPill>
        ) : null}
      </div>
      <div className="mt-2 text-sm leading-6 text-txt">
        {boundedText(preference.text)}
      </div>
      {preference.originalRequest ? (
        <details className="mt-2">
          <summary className="cursor-pointer text-xs leading-5 text-muted transition hover:text-txt">
            Original request
          </summary>
          <div className="mt-1 text-xs leading-5 text-muted">
            {boundedText(preference.originalRequest, 260)}
          </div>
        </details>
      ) : null}
      <div className="mt-2 text-xs text-muted">
        {formatDateTime(preference.createdAt, {
          fallback: "No timestamp",
        })}
      </div>
    </div>
  );

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
          {shownPreferences.map(renderPreference)}
          <MoreItems count={overflowCount(person.userPersonalityPreferences)}>
            {hiddenPreferences.map(renderPreference)}
          </MoreItems>
        </div>
      )}
    </PagePanel>
  );
}
