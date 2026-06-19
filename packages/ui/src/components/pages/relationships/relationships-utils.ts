import type {
  RelationshipsGraphQuery,
  RelationshipsGraphSnapshot,
  RelationshipsMergeCandidate,
  RelationshipsPersonDetail,
  RelationshipsPersonSummary,
} from "../../../api/client-types-relationships";

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
  const { platform, handle, notes, identityIds } = candidate.evidence;
  if (platform && handle) {
    parts.push(`${platform}:${handle}`);
  } else if (platform) {
    parts.push(platform);
  }
  if (notes) parts.push(notes);
  if (identityIds && identityIds.length > 0) {
    parts.push(`${identityIds.length} identities`);
  }
  return parts.join(" · ") || "No evidence";
}
