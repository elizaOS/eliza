import { Button, MetaPill, PagePanel } from "@elizaos/ui";
import {
  AtSign,
  BadgeCheck,
  Brain,
  CalendarClock,
  Crown,
  FileText,
  Fingerprint,
  Frown,
  Gauge,
  Globe2,
  Link2,
  Mail,
  Meh,
  MessageCircle,
  Pencil,
  Phone,
  Smile,
  Sparkles,
} from "lucide-react";
import {
  type ComponentType,
  type FormEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import { client } from "../../../api/client";
import type {
  RelationshipsGraphEdge,
  RelationshipsPersonDetail,
  RelationshipsProfile,
} from "../../../api/client-types-relationships";
import { formatDateTime } from "../../../utils/format";
import { RelationshipsIdentityCluster } from "../RelationshipsIdentityCluster";
import {
  profilePrimaryValue,
  profileSourceLabel,
  topContacts,
} from "./relationships-utils";

type RelationshipsDisplayPerson = RelationshipsPersonDetail;

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

function relationshipCounterpartName(
  relationship: RelationshipsGraphEdge,
  groupId: string,
): string {
  return relationship.sourcePersonId === groupId
    ? relationship.targetPersonName
    : relationship.sourcePersonName;
}

function sentimentClasses(sentiment: string): string {
  if (sentiment === "positive") {
    return "border-success/28 bg-success/10 text-success";
  }
  if (sentiment === "negative") {
    return "border-danger/28 bg-danger/10 text-danger";
  }
  return "border-warning/28 bg-warning/10 text-warning";
}

function sentimentIcon(
  sentiment: string,
): ComponentType<{ className?: string }> {
  if (sentiment === "positive") return Smile;
  if (sentiment === "negative") return Frown;
  return Meh;
}

function sentimentAriaLabel(sentiment: string): string {
  if (sentiment === "positive") return "Positive sentiment";
  if (sentiment === "negative") return "Negative sentiment";
  return "Neutral sentiment";
}

function sourceTypeIcon(
  sourceType: string,
): ComponentType<{ className?: string }> {
  if (sourceType === "memory") return Brain;
  if (sourceType === "contact") return AtSign;
  if (sourceType === "claim") return BadgeCheck;
  if (sourceType === "message") return MessageCircle;
  return Sparkles;
}

function IconPill({
  icon: Icon,
  children,
  ariaLabel,
}: {
  icon: ComponentType<{ className?: string }>;
  children?: ReactNode;
  ariaLabel?: string;
}) {
  return (
    <MetaPill compact>
      <span
        role="img"
        aria-label={ariaLabel ?? "icon"}
        className="inline-flex items-center gap-1"
      >
        <Icon className="h-3 w-3" />
        {children}
      </span>
    </MetaPill>
  );
}

function findOwnerEdge(
  person: RelationshipsPersonDetail,
  ownerGroupId: string | null,
): RelationshipsGraphEdge | null {
  if (!ownerGroupId || ownerGroupId === person.groupId) return null;
  return (
    person.relationships.find(
      (edge) =>
        edge.sourcePersonId === ownerGroupId ||
        edge.targetPersonId === ownerGroupId,
    ) ?? null
  );
}

function OwnerNameEditor({
  initialName,
  onSaved,
}: {
  initialName: string;
  onSaved: (next: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(initialName);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!editing) {
      setDraft(initialName);
    } else {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing, initialName]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const next = draft.trim();
    if (!next || next === initialName) {
      setEditing(false);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await client.updateConfig({ ui: { ownerName: next } });
      onSaved(next);
      setEditing(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save name.");
    } finally {
      setSaving(false);
    }
  };

  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        className="group inline-flex items-center gap-2 rounded-md text-left transition hover:bg-card/40"
        aria-label="Edit owner name"
      >
        <span className="break-words text-[1.75rem] font-semibold leading-tight text-txt">
          {initialName}
        </span>
        <Pencil className="h-4 w-4 opacity-0 transition group-hover:opacity-60" />
      </button>
    );
  }

  return (
    <form onSubmit={submit} className="flex items-center gap-2">
      <input
        ref={inputRef}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            setEditing(false);
          }
        }}
        disabled={saving}
        maxLength={60}
        className="min-w-0 flex-1 rounded-md border border-accent/40 bg-card/60 px-2 py-1 text-[1.5rem] font-semibold text-txt outline-none focus:border-accent"
        aria-label="Owner name"
      />
      <Button type="submit" size="sm" disabled={saving}>
        {saving ? "Saving..." : "Save"}
      </Button>
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={saving}
        onClick={() => setEditing(false)}
      >
        Cancel
      </Button>
      {error ? (
        <span className="text-xs text-danger" role="alert">
          {error}
        </span>
      ) : null}
    </form>
  );
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
            {profile.canonical ? <MetaPill compact>Primary</MetaPill> : null}
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
  ownerGroupId = null,
  ownerDisplayName = null,
  onViewMemories,
  onOwnerNameUpdated,
}: {
  person: RelationshipsDisplayPerson;
  compact?: boolean;
  ownerGroupId?: string | null;
  ownerDisplayName?: string | null;
  onViewMemories?: (entityIds: string[]) => void;
  onOwnerNameUpdated?: (next: string) => void;
}) {
  const avatarUrl = resolvePrimaryAvatar(person);
  const contacts = topContacts(person);
  const hasProfiles = person.profiles.length > 0;
  const ownerEdge = findOwnerEdge(person, ownerGroupId);
  const ownerLabel = ownerDisplayName ?? "Owner";

  const labels = [...person.categories, ...person.tags];

  return (
    <PagePanel variant="padded" className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          {avatarUrl ? (
            <img
              src={avatarUrl}
              alt=""
              className={`${compact ? "h-10 w-10 rounded-xl" : "h-12 w-12 rounded-2xl"} hidden border border-border/24 object-cover shadow-sm sm:block`}
            />
          ) : null}
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              {person.isOwner ? (
                <Crown
                  className="h-4 w-4 shrink-0 text-accent"
                  aria-label="Owner"
                />
              ) : null}
              {person.isOwner ? (
                <OwnerNameEditor
                  initialName={person.displayName}
                  onSaved={(next) => {
                    onOwnerNameUpdated?.(next);
                  }}
                />
              ) : (
                <div
                  className={`${compact ? "text-xl" : "text-2xl"} break-words font-semibold leading-tight text-txt`}
                >
                  {person.displayName}
                </div>
              )}
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
              {person.platforms.length > 0 ? (
                <span>{person.platforms.join(" · ")}</span>
              ) : null}
              {person.lastInteractionAt ? (
                <span className="inline-flex items-center gap-1">
                  <CalendarClock className="h-3 w-3" />
                  {formatDateTime(person.lastInteractionAt, { fallback: "—" })}
                </span>
              ) : null}
            </div>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <MetaPill compact>
            <Fingerprint className="mr-1 h-3 w-3" />
            {person.memberEntityIds.length}
          </MetaPill>
          <MetaPill compact>
            <Link2 className="mr-1 h-3 w-3" />
            {person.relationshipCount}
          </MetaPill>
          <MetaPill compact>
            <Brain className="mr-1 h-3 w-3" />
            {person.factCount}
          </MetaPill>
          {onViewMemories ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-7 rounded-full px-3 text-2xs font-semibold"
              onClick={() => onViewMemories(person.memberEntityIds)}
              aria-label="View memories"
            >
              <Brain className="h-3.5 w-3.5" />
            </Button>
          ) : null}
        </div>
      </div>

      {!person.isOwner ? (
        <OwnerRelationshipSection
          person={person}
          ownerLabel={ownerLabel}
          ownerEdge={ownerEdge}
        />
      ) : null}

      {labels.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {labels.map((label) => (
            <MetaPill key={`label:${label}`} compact>
              {label}
            </MetaPill>
          ))}
        </div>
      ) : null}

      {contacts.length > 0 ? (
        <div className="grid gap-1.5 sm:grid-cols-2">
          {contacts.map((contact) => {
            const Icon =
              contact.label === "Phone"
                ? Phone
                : contact.label === "Website"
                  ? Globe2
                  : Mail;
            return (
              <div
                key={`${contact.label}:${contact.value}`}
                className="flex items-center gap-2 rounded-lg border border-border/24 bg-card/30 px-2.5 py-1.5 text-xs"
              >
                <Icon className="h-3 w-3 shrink-0 text-accent" />
                <span className="min-w-0 truncate text-txt">
                  {contact.value}
                </span>
              </div>
            );
          })}
        </div>
      ) : null}

      {hasProfiles || compact ? (
        <details className="rounded-xl border border-border/24 bg-card/24 px-3 py-2">
          <summary className="cursor-pointer text-xs-tight font-semibold text-muted transition hover:text-txt">
            Profiles & identities
          </summary>
          <div className="mt-3 space-y-3">
            {hasProfiles ? <ProfilesPanel person={person} /> : null}
            <RelationshipsIdentityCluster person={person} />
          </div>
        </details>
      ) : (
        <RelationshipsIdentityCluster person={person} />
      )}
    </PagePanel>
  );
}

function OwnerRelationshipSection({
  person,
  ownerLabel,
  ownerEdge,
}: {
  person: RelationshipsPersonDetail;
  ownerLabel: string;
  ownerEdge: RelationshipsGraphEdge | null;
}) {
  const sentiment = ownerEdge?.sentiment ?? "neutral";
  const SentimentIcon = sentimentIcon(sentiment);
  const memoryCount = person.relevantMemories.length;
  const interactionCount = ownerEdge?.interactionCount ?? 0;
  const strengthPercent = ownerEdge
    ? Math.round(ownerEdge.strength * 100)
    : null;
  const types = ownerEdge?.relationshipTypes ?? [];

  return (
    <PagePanel
      variant="surface"
      className="border border-accent/20 bg-accent/[0.04] px-3 py-2"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-txt">
          <Crown className="h-3.5 w-3.5 text-accent" />
          {ownerLabel}
          <span className="text-muted" aria-hidden>
            ↔
          </span>
          {person.displayName}
        </span>
        <span className="ml-auto flex flex-wrap items-center gap-1.5">
          <span
            role="img"
            aria-label={sentimentAriaLabel(sentiment)}
            className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-2xs font-semibold ${sentimentClasses(sentiment)}`}
          >
            <SentimentIcon className="h-3 w-3" />
            {strengthPercent !== null ? `${strengthPercent}%` : "—"}
          </span>
          <MetaPill compact>
            <MessageCircle className="mr-1 h-3 w-3" />
            {interactionCount}
          </MetaPill>
          <MetaPill compact>
            <Brain className="mr-1 h-3 w-3" />
            {memoryCount}
          </MetaPill>
          {types.slice(0, 3).map((entry) => (
            <MetaPill key={`owner-rel:${entry}`} compact>
              {entry}
            </MetaPill>
          ))}
        </span>
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
    const SourceIcon = sourceTypeIcon(fact.sourceType);
    return (
      <div
        key={fact.id}
        className="rounded-xl border border-border/24 bg-card/32 px-3.5 py-3"
      >
        <div className="flex flex-wrap items-center gap-1.5">
          <IconPill icon={SourceIcon} ariaLabel={`${fact.sourceType} fact`} />
          {fact.field ? <MetaPill compact>{fact.field}</MetaPill> : null}
          {fact.extractedInformation?.scope ? (
            <MetaPill compact>{fact.extractedInformation.scope}</MetaPill>
          ) : null}
          {typeof fact.confidence === "number" ? (
            <IconPill icon={Gauge} ariaLabel="Confidence">
              {Math.round(fact.confidence * 100)}%
            </IconPill>
          ) : null}
          {evidenceCount > 0 ? (
            <IconPill icon={FileText} ariaLabel="Evidence count">
              {evidenceCount}
            </IconPill>
          ) : null}
        </div>
        <div className="mt-2 text-sm leading-6 text-txt">
          {boundedText(fact.text)}
        </div>
        <div className="mt-2 text-xs text-muted">
          {fact.lastReinforced
            ? `Reinforced ${formatDateTime(fact.lastReinforced, { fallback: "No date" })}`
            : formatDateTime(fact.updatedAt, {
                fallback: "No date",
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
        </div>
        <MetaPill compact>{person.facts.length}</MetaPill>
      </div>

      {person.facts.length === 0 ? (
        <p className="mt-4 text-sm leading-6 text-muted">No facts extracted.</p>
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
  ) => {
    const SentimentIcon = sentimentIcon(relationship.sentiment);
    const types = relationship.relationshipTypes;
    return (
      <div
        key={relationship.id}
        className="rounded-xl border border-border/24 bg-card/32 px-3 py-2"
      >
        <div className="flex flex-wrap items-center gap-1.5">
          <span
            role="img"
            aria-label={sentimentAriaLabel(relationship.sentiment)}
            className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-2xs font-semibold ${sentimentClasses(relationship.sentiment)}`}
          >
            <SentimentIcon className="h-3 w-3" />
            {Math.round(relationship.strength * 100)}%
          </span>
          <span className="inline-flex items-center gap-1 text-2xs font-semibold text-muted">
            <MessageCircle className="h-3 w-3" />
            {relationship.interactionCount}
          </span>
          <span className="ml-1 truncate text-sm font-semibold text-txt">
            {relationshipCounterpartName(relationship, person.groupId)}
          </span>
          <span className="ml-auto inline-flex items-center gap-1 text-2xs text-muted">
            <CalendarClock className="h-3 w-3" />
            {formatDateTime(relationship.lastInteractionAt, { fallback: "—" })}
          </span>
        </div>
        {types.length > 0 ? (
          <div className="mt-1 flex flex-wrap gap-1">
            {types.slice(0, 3).map((entry) => (
              <span
                key={`rel-type:${relationship.id}:${entry}`}
                className="text-2xs text-muted/80"
              >
                {entry}
              </span>
            ))}
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
            Relationships
          </div>
        </div>
        <MetaPill compact>{person.relationships.length}</MetaPill>
      </div>

      {person.relationships.length === 0 ? (
        <p className="mt-4 text-sm leading-6 text-muted">
          No relationships recorded.
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
            fallback: "No date",
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
        </div>
        <MetaPill compact>{person.recentConversations.length}</MetaPill>
      </div>

      {person.recentConversations.length === 0 ? (
        <p className="mt-4 text-sm leading-6 text-muted">
          No conversations linked.
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
  const renderMemory = (memory: (typeof person.relevantMemories)[number]) => {
    const SourceIcon = sourceTypeIcon(memory.sourceType);
    return (
      <div
        key={memory.id}
        className="rounded-xl border border-border/24 bg-card/32 px-3.5 py-3"
      >
        <div className="flex flex-wrap items-center gap-1.5">
          <IconPill icon={SourceIcon} ariaLabel={memory.sourceType} />
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
          {formatDateTime(memory.createdAt, { fallback: "No date" })}
        </div>
      </div>
    );
  };

  return (
    <PagePanel variant="surface" className="px-4 py-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-xs-tight font-semibold uppercase tracking-[0.16em] text-muted/70">
            Relevant memories
          </div>
        </div>
        <MetaPill compact>{person.relevantMemories.length}</MetaPill>
      </div>

      {person.relevantMemories.length === 0 ? (
        <p className="mt-4 text-sm leading-6 text-muted">
          No relevant memories.
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
      <div className="flex flex-wrap items-center gap-1.5">
        <IconPill icon={Sparkles} ariaLabel="Preference">
          {preference.category ?? "preference"}
        </IconPill>
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
          fallback: "No date",
        })}
      </div>
    </div>
  );

  return (
    <PagePanel variant="surface" className="px-4 py-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-xs-tight font-semibold uppercase tracking-[0.16em] text-muted/70">
            Preferences
          </div>
        </div>
        <MetaPill compact>{person.userPersonalityPreferences.length}</MetaPill>
      </div>

      {person.userPersonalityPreferences.length === 0 ? (
        <p className="mt-4 text-sm leading-6 text-muted">
          No preferences learned.
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
