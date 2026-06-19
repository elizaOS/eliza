export type CharacterHubActivityKind =
  | "personality"
  | "documents"
  | "experience"
  | "relationship";

export interface CharacterHubActivityItem {
  id: string;
  kind: CharacterHubActivityKind;
  title: string;
  description: string;
  badge?: string | null;
  meta?: string | null;
  timestamp?: string | null;
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
  keywords?: string[];
  associatedEntityIds?: string[];
  domain?: string | null;
  confidence: number;
  importance: number;
  createdAt: string | number;
  updatedAt?: string | number | null;
  supersedes?: string | null;
  relatedExperienceIds?: string[];
  mergedExperienceIds?: string[];
  embeddingDimensions?: number | null;
  previousBelief?: string | null;
  correctedBelief?: string | null;
  sourceMessageIds?: string[];
  sourceRoomId?: string | null;
  sourceTriggerMessageId?: string | null;
  sourceTrajectoryId?: string | null;
  sourceTrajectoryStepId?: string | null;
  extractionMethod?: string | null;
  extractionReason?: string | null;
}

export interface CharacterExperienceDraft {
  learning: string;
  importance: number;
  confidence: number;
  tags: string;
}
