import type { ExperienceRecord } from "../../api/client-types-experience";
/** Character editor projections and editable form drafts. */
export type CharacterPersonalityHistoryScope = "auto" | "global" | "user";

export interface CharacterPersonalityHistoryItem {
  id: string;
  field: string;
  scope: CharacterPersonalityHistoryScope;
  timestamp: string;
  actor?: string | null;
  summary?: string | null;
  reason?: string | null;
  beforeText?: string | null;
  afterText?: string | null;
  relatedEntityName?: string | null;
}

export interface CharacterExperienceRecord
  extends Omit<
    ExperienceRecord,
    | "domain"
    | "updatedAt"
    | "accessCount"
    | "relatedExperiences"
    | "lastAccessedAt"
  > {
  domain?: string | null;
  updatedAt?: string | number | null;
  relatedExperienceIds?: string[];
}

export interface CharacterExperienceDraft {
  learning: string;
  importance: number;
  confidence: number;
  tags: string;
}
