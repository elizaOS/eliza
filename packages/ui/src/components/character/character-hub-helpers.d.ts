import type {
  CharacterHistoryEntry,
  DocumentRecord,
  ExperienceRecord,
  RelationshipsActivityItem,
} from "../../api";
import type {
  CharacterExperienceRecord,
  CharacterHubActivityItem,
  CharacterPersonalityHistoryItem,
} from "./character-hub-types";
export declare const CHARACTER_HUB_SECTIONS: readonly [
  "overview",
  "personality",
  "documents",
  "skills",
  "experience",
  "relationships",
];
export type CharacterHubSection = (typeof CHARACTER_HUB_SECTIONS)[number];
export declare function getCharacterHubSectionLabel(
  section: CharacterHubSection,
): string;
export declare function mapHistoryEntryToTimelineItem(
  entry: CharacterHistoryEntry,
): CharacterPersonalityHistoryItem;
export declare function mapExperienceRecordToHubRecord(
  experience: ExperienceRecord,
): CharacterExperienceRecord;
export declare function buildCharacterOverviewItems(options: {
  history: CharacterHistoryEntry[];
  documents: DocumentRecord[];
  experiences: ExperienceRecord[];
  relationshipActivity: RelationshipsActivityItem[];
}): CharacterHubActivityItem[];
//# sourceMappingURL=character-hub-helpers.d.ts.map
