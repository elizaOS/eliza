import {
  AtSign,
  BadgeCheck,
  Bot,
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
  Shield,
  Smile,
  Sparkles,
  User,
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
import type { DocumentRecord } from "../../../api/client-types-chat";
import type {
  RelationshipsGraphEdge,
  RelationshipsPersonDetail,
  RelationshipsProfile,
} from "../../../api/client-types-relationships";
import { shouldUseHashNavigation } from "../../../navigation";
import { formatDateTime, formatShortDate } from "../../../utils/format";
import { PagePanel } from "../../composites/page-panel";
import { MetaPill } from "../../composites/page-panel/page-panel-header";
import { Button } from "../../ui/button";
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
const SOURCE_PREFIX_PATTERN =
  /^\[(?:discord|telegram|slack|twitter|x|gmail|email|message)[^\]]*\]\s*/i;

function boundedText(value: string, maxLength = TEXT_PREVIEW_LENGTH): string {
  const trimmed = value.trim();
  return trimmed.length > maxLength
    ? `${trimmed.slice(0, maxLength - 1)}...`
    : trimmed;
}

function cleanPreviewText(value: string, maxLength = TEXT_PREVIEW_LENGTH) {
  return boundedText(value.replace(SOURCE_PREFIX_PATTERN, ""), maxLength);
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
    <details>
      <summary className="inline-flex cursor-pointer list-none items-center rounded-full border border-border/24 bg-card/24 px-2 py-0.5 text-2xs font-semibold text-muted transition hover:text-txt">
        +{count}
      </summary>
      <div className="mt-2 space-y-2">{children}</div>
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

function PanelMarker({
  icon: Icon,
  count,
  label,
}: {
  icon: ComponentType<{ className?: string }>;
  count: number;
  label: string;
}) {
  return (
    <div className="mb-2 flex justify-end">
      <MetaPill compact aria-label={`${label} count`} title={label}>
        <Icon className="mr-1 h-3 w-3" />
        {count}
      </MetaPill>
    </div>
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
    <li className="flex min-w-0 items-center gap-2 rounded-lg border border-border/24 bg-card/30 px-2.5 py-1.5 text-xs">
      {profile.avatarUrl ? (
        <img
          src={profile.avatarUrl}
          alt=""
          className="h-7 w-7 shrink-0 rounded-full border border-border/24 object-cover"
        />
      ) : (
        <AtSign className="h-3 w-3 shrink-0 text-accent" />
      )}
      <span className="shrink-0 rounded-full bg-card/60 px-1.5 py-0.5 text-2xs font-semibold uppercase tracking-[0.1em] text-muted">
        {profileSourceLabel(profile.source)}
      </span>
      <span className="min-w-0 truncate font-semibold text-txt">
        {primaryValue}
      </span>
      {secondary ? (
        <span className="ml-auto min-w-0 truncate text-muted">{secondary}</span>
      ) : null}
      {profile.canonical ? (
        <BadgeCheck className="h-3 w-3 shrink-0 text-accent" />
      ) : null}
    </li>
  );
}

function ProfilesPanel({ person }: { person: RelationshipsDisplayPerson }) {
  return (
    <ul className="space-y-1.5">
      {person.profiles.map((profile) => (
        <ProfileCard
          key={`${profile.source}:${profile.entityId}`}
          person={person}
          profile={profile}
        />
      ))}
    </ul>
  );
}

function PanelEmpty({
  icon: Icon,
  children,
}: {
  icon: ComponentType<{ className?: string }>;
  children: ReactNode;
}) {
  return (
    <div className="flex items-center gap-2 px-1 py-2 text-sm text-muted">
      <Icon className="h-4 w-4 text-muted/70" />
      <span>{children}</span>
    </div>
  );
}

function formatCompactDate(value: string | number | undefined): string {
  return formatShortDate(value, { fallback: "—" });
}

function renderInlineSpeaker(speaker: string, text: string, maxLength: number) {
  return (
    <>
      <span className="font-semibold text-muted">{speaker}: </span>
      {cleanPreviewText(text, maxLength)}
    </>
  );
}

function DataPanel({
  label,
  icon,
  count,
  children,
}: {
  label: string;
  icon: ComponentType<{ className?: string }>;
  count: number;
  children: ReactNode;
}) {
  return (
    <PagePanel
      as="section"
      variant="surface"
      aria-label={label}
      className="px-3 py-3"
    >
      <PanelMarker icon={icon} count={count} label={label} />
      {children}
    </PagePanel>
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
                <span
                  className="inline-flex items-center gap-1"
                  title={formatDateTime(person.lastInteractionAt, {
                    fallback: "No date",
                  })}
                >
                  <CalendarClock className="h-3 w-3" />
                  {formatCompactDate(person.lastInteractionAt)}
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

      {hasProfiles || person.identities.length > 0 ? (
        <details className="rounded-xl border border-border/24 bg-card/24 px-3 py-2">
          <summary
            className="inline-flex cursor-pointer list-none items-center gap-2 rounded-full text-xs-tight font-semibold text-muted transition hover:text-txt"
            title="Profiles and identities"
          >
            <AtSign className="h-3 w-3" />
            {person.profiles.length}
            <Fingerprint className="h-3 w-3" />
            {person.identities.length}
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
      title={types.join(", ")}
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
        </span>
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
        className="rounded-xl border border-border/24 bg-card/32 px-3 py-2.5"
      >
        <div className="flex flex-wrap items-center gap-1.5">
          <IconPill icon={SourceIcon} ariaLabel={`${fact.sourceType} fact`} />
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
          {cleanPreviewText(fact.text)}
        </div>
      </div>
    );
  };

  return (
    <DataPanel label="Facts" icon={BadgeCheck} count={person.facts.length}>
      {person.facts.length === 0 ? (
        <PanelEmpty icon={BadgeCheck}>No facts.</PanelEmpty>
      ) : (
        <div className="space-y-2">
          {shownFacts.map(renderFact)}
          <MoreItems count={overflowCount(person.facts)}>
            {hiddenFacts.map(renderFact)}
          </MoreItems>
        </div>
      )}
    </DataPanel>
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
          <span
            className="ml-auto inline-flex items-center gap-1 text-2xs text-muted"
            title={formatDateTime(relationship.lastInteractionAt, {
              fallback: "No date",
            })}
          >
            <CalendarClock className="h-3 w-3" />
            {formatCompactDate(relationship.lastInteractionAt)}
          </span>
        </div>
      </div>
    );
  };

  return (
    <DataPanel
      label="Relationships"
      icon={Link2}
      count={person.relationships.length}
    >
      {person.relationships.length === 0 ? (
        <PanelEmpty icon={Link2}>No relationships.</PanelEmpty>
      ) : (
        <div className="space-y-2">
          {shownRelationships.map(renderRelationship)}
          <MoreItems count={overflowCount(person.relationships)}>
            {hiddenRelationships.map(renderRelationship)}
          </MoreItems>
        </div>
      )}
    </DataPanel>
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
      className="rounded-xl border border-border/24 bg-card/32 px-3 py-2.5"
    >
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0 truncate text-sm font-semibold text-txt">
          {conversation.roomName}
        </div>
        <div
          className="inline-flex shrink-0 items-center gap-1 text-2xs text-muted"
          title={formatDateTime(conversation.lastActivityAt, {
            fallback: "No date",
          })}
        >
          <CalendarClock className="h-3 w-3" />
          {formatCompactDate(conversation.lastActivityAt)}
        </div>
      </div>

      <div className="mt-2 space-y-1.5">
        {conversation.messages
          .slice(0, MESSAGE_PREVIEW_LIMIT)
          .map((message) => (
            <div
              key={message.id}
              className="rounded-lg bg-card/45 px-2.5 py-1.5 text-sm leading-6 text-txt"
            >
              {renderInlineSpeaker(message.speaker, message.text, 300)}
            </div>
          ))}
        {conversation.messages.length > MESSAGE_PREVIEW_LIMIT ? (
          <div className="text-xs-tight text-muted">
            +{conversation.messages.length - MESSAGE_PREVIEW_LIMIT}
          </div>
        ) : null}
      </div>
    </div>
  );

  return (
    <DataPanel
      label="Conversations"
      icon={MessageCircle}
      count={person.recentConversations.length}
    >
      {person.recentConversations.length === 0 ? (
        <PanelEmpty icon={MessageCircle}>No conversations.</PanelEmpty>
      ) : (
        <div className="grid gap-2 xl:grid-cols-2">
          {shownConversations.map(renderConversation)}
          <div className="xl:col-span-2">
            <MoreItems
              count={overflowCount(
                person.recentConversations,
                CONVERSATION_PREVIEW_LIMIT,
              )}
            >
              <div className="grid gap-2 xl:grid-cols-2">
                {hiddenConversations.map(renderConversation)}
              </div>
            </MoreItems>
          </div>
        </div>
      )}
    </DataPanel>
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
        className="rounded-xl border border-border/24 bg-card/32 px-3 py-2.5"
      >
        <div className="flex flex-wrap items-center gap-1.5">
          <IconPill icon={SourceIcon} ariaLabel={memory.sourceType} />
          {memory.createdAt ? (
            <span
              className="ml-auto inline-flex items-center gap-1 text-2xs text-muted"
              title={formatDateTime(memory.createdAt, {
                fallback: "No date",
              })}
            >
              <CalendarClock className="h-3 w-3" />
              {formatCompactDate(memory.createdAt)}
            </span>
          ) : null}
        </div>
        <div className="mt-1 text-sm leading-6 text-txt">
          {renderInlineSpeaker(
            memory.speaker,
            memory.text,
            TEXT_PREVIEW_LENGTH,
          )}
        </div>
      </div>
    );
  };

  return (
    <DataPanel
      label="Memories"
      icon={Brain}
      count={person.relevantMemories.length}
    >
      {person.relevantMemories.length === 0 ? (
        <PanelEmpty icon={Brain}>No memories.</PanelEmpty>
      ) : (
        <div className="space-y-2">
          {shownMemories.map(renderMemory)}
          <MoreItems count={overflowCount(person.relevantMemories)}>
            {hiddenMemories.map(renderMemory)}
          </MoreItems>
        </div>
      )}
    </DataPanel>
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
      className="rounded-xl border border-border/24 bg-card/32 px-3 py-2.5"
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <IconPill icon={Sparkles} ariaLabel="Preference">
          {preference.category ?? "preference"}
        </IconPill>
        {preference.createdAt ? (
          <span
            className="ml-auto inline-flex items-center gap-1 text-2xs text-muted"
            title={formatDateTime(preference.createdAt, {
              fallback: "No date",
            })}
          >
            <CalendarClock className="h-3 w-3" />
            {formatCompactDate(preference.createdAt)}
          </span>
        ) : null}
      </div>
      <div className="mt-2 text-sm leading-6 text-txt">
        {cleanPreviewText(preference.text)}
      </div>
      {preference.originalRequest ? (
        <details className="mt-2">
          <summary className="inline-flex cursor-pointer list-none items-center rounded-full border border-border/24 bg-card/24 px-2 py-0.5 text-2xs font-semibold text-muted transition hover:text-txt">
            <FileText className="mr-1 h-3 w-3" />
            request
          </summary>
          <div className="mt-1 text-xs leading-5 text-muted">
            {cleanPreviewText(preference.originalRequest, 260)}
          </div>
        </details>
      ) : null}
    </div>
  );

  return (
    <DataPanel
      label="Preferences"
      icon={Sparkles}
      count={person.userPersonalityPreferences.length}
    >
      {person.userPersonalityPreferences.length === 0 ? (
        <PanelEmpty icon={Sparkles}>No preferences.</PanelEmpty>
      ) : (
        <div className="space-y-2">
          {shownPreferences.map(renderPreference)}
          <MoreItems count={overflowCount(person.userPersonalityPreferences)}>
            {hiddenPreferences.map(renderPreference)}
          </MoreItems>
        </div>
      )}
    </DataPanel>
  );
}

export function RelationshipsDocumentsPanel({
  person,
}: {
  person: RelationshipsDisplayPerson;
}) {
  const [documents, setDocuments] = useState<DocumentRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const memberEntityKey = person.memberEntityIds.join("\0");

  const openDocumentsPage = () => {
    if (typeof window === "undefined") return;
    const path = "/character/documents";
    if (shouldUseHashNavigation()) {
      window.location.hash = path;
    } else {
      window.history.pushState(null, "", path);
      window.dispatchEvent(new PopStateEvent("popstate"));
    }
  };

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    const entityIds = Array.from(
      new Set(memberEntityKey.split("\0").filter((id) => id.trim().length > 0)),
    );

    async function load() {
      try {
        const responses = await Promise.all(
          entityIds.map((entityId) =>
            client.listDocuments({
              scope: "user-private",
              scopedToEntityId: entityId,
              limit: 100,
            }),
          ),
        );
        if (cancelled) return;
        const byId = new Map<string, DocumentRecord>();
        for (const response of responses) {
          for (const doc of response.documents) {
            byId.set(doc.id, doc);
          }
        }
        setDocuments(
          Array.from(byId.values()).sort(
            (left, right) =>
              Number(right.createdAt ?? 0) - Number(left.createdAt ?? 0),
          ),
        );
      } catch (loadError) {
        if (cancelled) return;
        setError(
          loadError instanceof Error
            ? loadError.message
            : "Failed to load documents.",
        );
        setDocuments([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    if (entityIds.length === 0) {
      setDocuments([]);
      setLoading(false);
    } else {
      load();
    }
    return () => {
      cancelled = true;
    };
  }, [memberEntityKey]);

  const shownDocuments = visibleItems(documents);
  const hiddenDocuments = documents.slice(PANEL_PREVIEW_LIMIT);

  const renderDocument = (doc: DocumentRecord) => {
    const ScopeIcon =
      doc.scope === "owner-private"
        ? Shield
        : doc.scope === "agent-private"
          ? Bot
          : doc.scope === "global"
            ? Globe2
            : User;
    return (
      <div
        key={doc.id}
        className="rounded-xl border border-border/24 bg-card/32 px-3 py-2.5"
      >
        <div className="flex flex-wrap items-center gap-1.5">
          <IconPill icon={FileText} ariaLabel="Document">
            {doc.filename}
          </IconPill>
          <IconPill icon={ScopeIcon} ariaLabel="Scope">
            {doc.scope ?? "global"}
          </IconPill>
          {doc.createdAt ? (
            <span
              className="ml-auto inline-flex items-center gap-1 text-2xs text-muted"
              title={formatDateTime(doc.createdAt, { fallback: "No date" })}
            >
              <CalendarClock className="h-3 w-3" />
              {formatCompactDate(doc.createdAt)}
            </span>
          ) : null}
        </div>
        {doc.content?.text ? (
          <div className="mt-2 text-sm leading-6 text-txt">
            {cleanPreviewText(doc.content.text)}
          </div>
        ) : null}
        <button
          type="button"
          onClick={openDocumentsPage}
          className="mt-2 inline-flex items-center gap-1 rounded-full border border-border/24 bg-card/24 px-2 py-0.5 text-2xs font-semibold text-muted transition hover:text-txt"
        >
          <Link2 className="h-3 w-3" />
          Open
        </button>
      </div>
    );
  };

  return (
    <DataPanel label="Documents" icon={FileText} count={documents.length}>
      {loading ? (
        <PanelEmpty icon={FileText}>Loading documents...</PanelEmpty>
      ) : error ? (
        <PanelEmpty icon={FileText}>{error}</PanelEmpty>
      ) : documents.length === 0 ? (
        <PanelEmpty icon={FileText}>No documents.</PanelEmpty>
      ) : (
        <div className="space-y-2">
          {shownDocuments.map(renderDocument)}
          <MoreItems count={overflowCount(documents)}>
            {hiddenDocuments.map(renderDocument)}
          </MoreItems>
        </div>
      )}
    </DataPanel>
  );
}
