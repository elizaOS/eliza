import type {
  RelationshipsGraphQuery,
  RelationshipsGraphSnapshot,
  RelationshipsMergeCandidate,
  RelationshipsPersonDetail,
  RelationshipsPersonSummary,
} from "../../../api/client-types-relationships";

export const RELATIONSHIPS_TOOLBAR_BUTTON_CLASS =
  "h-8 rounded-full px-3.5 text-2xs font-semibold tracking-[0.12em] border border-border/32 bg-[linear-gradient(180deg,color-mix(in_srgb,var(--card)_84%,transparent),color-mix(in_srgb,var(--bg)_95%,transparent))] text-muted-strong shadow-[inset_0_1px_0_rgba(255,255,255,0.14),0_14px_20px_-18px_rgba(15,23,42,0.14)] backdrop-blur-md transition-[border-color,background-color,color,transform,box-shadow] duration-200 hover:border-border/46 hover:bg-[linear-gradient(180deg,color-mix(in_srgb,var(--card)_90%,transparent),color-mix(in_srgb,var(--bg)_97%,transparent))] hover:text-txt hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.16),0_16px_22px_-18px_rgba(15,23,42,0.16)] active:scale-95 disabled:hover:border-border/32 disabled:hover:bg-[linear-gradient(180deg,color-mix(in_srgb,var(--card)_84%,transparent),color-mix(in_srgb,var(--bg)_95%,transparent))] disabled:hover:text-muted-strong";

export type RelationshipsPersonSupplementalDetail = {
  headline?: string | null;
  bio?: string | null;
  notes?: string | null;
  occupations?: string[];
  locations?: string[];
  organizations?: string[];
};

type PersonContactRow = {
  label: string;
  value: string;
};

function toTimestamp(value?: string): number {
  if (!value) return 0;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

export function buildRelationshipsGraphQuery(
  search: string,
  platform: string,
  limit = 200,
): RelationshipsGraphQuery {
  return {
    search: search.trim() || undefined,
    platform: platform === "all" ? undefined : platform,
    limit,
  };
}

export function sortPeople(
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

export function summarizeHandles(person: RelationshipsPersonSummary): string {
  const handles = person.identities.flatMap((identity) =>
    identity.handles.map((handle) => `@${handle.handle}`),
  );
  return handles.slice(0, 3).join(", ");
}

export function platformOptions(
  snapshot: RelationshipsGraphSnapshot | null,
): string[] {
  if (!snapshot) return [];
  return [...new Set(snapshot.people.flatMap((person) => person.platforms))]
    .filter((platform) => platform.trim().length > 0)
    .sort((left, right) => left.localeCompare(right));
}

export function topContacts(
  person: RelationshipsPersonDetail,
): PersonContactRow[] {
  const rows: PersonContactRow[] = [];
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

export function buildAdditionalHighlights(
  person: RelationshipsPersonDetail & RelationshipsPersonSupplementalDetail,
): PersonContactRow[] {
  const rows: PersonContactRow[] = [];
  if (person.organizations?.length) {
    rows.push({
      label: "Organizations",
      value: person.organizations.join(", "),
    });
  }
  if (person.occupations?.length) {
    rows.push({ label: "Roles", value: person.occupations.join(", ") });
  }
  if (person.locations?.length) {
    rows.push({ label: "Locations", value: person.locations.join(", ") });
  }
  return rows;
}

export function profileSourceLabel(source: string): string {
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

export function profilePrimaryValue(
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

export function personLabel(
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

export function evidenceSummary(
  candidate: RelationshipsMergeCandidate,
): string {
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
