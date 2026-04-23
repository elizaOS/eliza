export type CharacterHubActivityKind =
  | "personality"
  | "knowledge"
  | "experience"
  | "relationship";

export interface CharacterHubActivityItem {
  id: string;
  kind: CharacterHubActivityKind;
  title: string;
  description: string;
  timestamp?: string | null;
  badge?: string | null;
  meta?: string | null;
}

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

export interface CharacterExperienceRecord {
  id: string;
  type: string;
  outcome: string;
  context: string;
  action: string;
  result: string;
  learning: string;
  tags: string[];
  domain?: string | null;
  confidence: number;
  importance: number;
  createdAt: string | number;
  updatedAt?: string | number | null;
  supersedes?: string | null;
  relatedExperienceIds?: string[];
  previousBelief?: string | null;
  correctedBelief?: string | null;
}

export interface CharacterExperienceDraft {
  learning: string;
  importance: number;
  confidence: number;
  tags: string;
}
