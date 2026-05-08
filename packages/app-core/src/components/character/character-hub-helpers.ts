import type {
  CharacterHistoryEntry,
  ExperienceRecord,
  DocumentRecord,
  RelationshipsActivityItem,
} from "../../api";
import type {
  CharacterExperienceRecord,
  CharacterHubActivityItem,
  CharacterPersonalityHistoryItem,
} from "./character-hub-types";

export const CHARACTER_HUB_SECTIONS = [
  "overview",
  "personality",
  "documents",
  "skills",
  "experience",
  "relationships",
] as const;

export type CharacterHubSection = (typeof CHARACTER_HUB_SECTIONS)[number];

export function getCharacterHubSectionLabel(
  section: CharacterHubSection,
): string {
  switch (section) {
    case "overview":
      return "Overview";
    case "personality":
      return "Personality";
    case "documents":
      return "Knowledge";
    case "skills":
      return "Skills";
    case "experience":
      return "Experience";
    case "relationships":
      return "Relationships";
    default:
      return "Overview";
  }
}

function toIsoString(value: string | number | undefined | null): string | null {
  if (value === null || value === undefined) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

export function mapHistoryEntryToTimelineItem(
  entry: CharacterHistoryEntry,
): CharacterPersonalityHistoryItem {
  const firstField = entry.fieldsChanged[0] ?? "system";
  const beforeValue = entry.changes[0]?.before;
  const afterValue = entry.changes[0]?.after;
  return {
    id: entry.id ?? `${entry.source}:${entry.timestamp}`,
    field: String(firstField),
    scope:
      entry.source === "manual"
        ? "global"
        : entry.source === "restore"
          ? "global"
          : "auto",
    timestamp: new Date(entry.timestamp).toISOString(),
    actor:
      entry.source === "manual"
        ? "Owner"
        : entry.source === "restore"
          ? "Restore"
          : "Agent",
    summary: entry.summary,
    reason:
      entry.fieldsChanged.length > 0
        ? `Changed ${entry.fieldsChanged.join(", ")}.`
        : null,
    beforeText:
      beforeValue === undefined ? null : JSON.stringify(beforeValue, null, 2),
    afterText:
      afterValue === undefined ? null : JSON.stringify(afterValue, null, 2),
  };
}

export function mapExperienceRecordToHubRecord(
  experience: ExperienceRecord,
): CharacterExperienceRecord {
  return {
    id: experience.id,
    type: experience.type,
    outcome: experience.outcome,
    context: experience.context,
    action: experience.action,
    result: experience.result,
    learning: experience.learning,
    tags: experience.tags,
    keywords: experience.keywords,
    associatedEntityIds: experience.associatedEntityIds,
    domain: experience.domain,
    confidence: experience.confidence,
    importance: experience.importance,
    createdAt: experience.createdAt,
    updatedAt: experience.updatedAt,
    supersedes: experience.supersedes,
    relatedExperienceIds: experience.relatedExperiences,
    mergedExperienceIds: experience.mergedExperienceIds,
    embeddingDimensions: experience.embeddingDimensions,
    previousBelief: experience.previousBelief,
    correctedBelief: experience.correctedBelief,
    sourceMessageIds: experience.sourceMessageIds,
    sourceRoomId: experience.sourceRoomId,
    sourceTriggerMessageId: experience.sourceTriggerMessageId,
    sourceTrajectoryId: experience.sourceTrajectoryId,
    sourceTrajectoryStepId: experience.sourceTrajectoryStepId,
    extractionMethod: experience.extractionMethod,
    extractionReason: experience.extractionReason,
  };
}

export function buildCharacterOverviewItems(options: {
  history: CharacterHistoryEntry[];
  documents: DocumentRecord[];
  experiences: ExperienceRecord[];
  relationshipActivity: RelationshipsActivityItem[];
}): CharacterHubActivityItem[] {
  const historyItems: CharacterHubActivityItem[] = options.history.map(
    (entry) => ({
      id: `history:${entry.id ?? entry.timestamp}`,
      kind: "personality",
      title: entry.summary || "Character updated",
      description:
        entry.fieldsChanged.length > 0
          ? `Changed ${entry.fieldsChanged.join(", ")}.`
          : "Personality changed.",
      timestamp: new Date(entry.timestamp).toISOString(),
    }),
  );

  const documentItems: CharacterHubActivityItem[] = options.documents.map(
    (document) => ({
      id: `documents:${document.id}`,
      kind: "documents",
      title: document.filename,
      description:
        document.source === "learned"
          ? "Learned knowledge added by the agent."
          : "Knowledge document added to the character workspace.",
      timestamp: toIsoString(document.createdAt),
    }),
  );

  const experienceItems: CharacterHubActivityItem[] = options.experiences.map(
    (experience) => ({
      id: `experience:${experience.id}`,
      kind: "experience",
      title: experience.learning || experience.result || experience.type,
      description:
        experience.context || experience.action || "Experience recorded.",
      timestamp: toIsoString(experience.updatedAt ?? experience.createdAt),
    }),
  );

  const relationshipItems: CharacterHubActivityItem[] =
    options.relationshipActivity.map((item) => ({
      id: `relationship:${item.personId}:${item.summary}:${item.timestamp ?? "na"}`,
      kind: "relationship",
      title: item.summary,
      description:
        item.type === "relationship"
          ? "Relationship signal updated."
          : item.type === "identity"
            ? `Identity linked for ${item.personName}.`
            : "Relationship fact recorded.",
      timestamp: item.timestamp,
    }));

  return [
    ...historyItems,
    ...documentItems,
    ...experienceItems,
    ...relationshipItems,
  ].sort((left, right) => {
    const leftTime = left.timestamp ? new Date(left.timestamp).getTime() : 0;
    const rightTime = right.timestamp ? new Date(right.timestamp).getTime() : 0;
    return rightTime - leftTime;
  });
}
