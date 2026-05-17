export interface ExperienceRecord {
  id: string;
  type: string;
  outcome: string;
  context: string;
  action: string;
  result: string;
  learning: string;
  tags: string[];
  domain: string;
  keywords?: string[];
  associatedEntityIds?: string[];
  confidence: number;
  importance: number;
  createdAt: number | string;
  updatedAt: number | string;
  lastAccessedAt?: number | string | null;
  accessCount: number;
  relatedExperiences?: string[];
  supersedes?: string | null;
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

export interface ExperienceListResponse {
  experiences: ExperienceRecord[];
  total: number;
}

export interface ExperienceListQuery {
  q?: string;
  query?: string;
  limit?: number;
  offset?: number;
  type?: string | string[];
  outcome?: string | string[];
  domain?: string | string[];
  tags?: string[];
  minConfidence?: number;
  minImportance?: number;
  includeRelated?: boolean;
}

export interface ExperienceUpdateInput {
  learning?: string;
  importance?: number;
  confidence?: number;
  tags?: string[];
  keywords?: string[];
  associatedEntityIds?: string[];
}

export interface ExperienceGraphNode {
  id: string;
  label: string;
  type: string;
  outcome: string;
  domain: string;
  keywords: string[];
  associatedEntityIds: string[];
  confidence: number;
  importance: number;
  timeWeight: number;
  x: number;
  y: number;
}

export interface ExperienceGraphLink {
  sourceId: string;
  targetId: string;
  type: "similar" | "supports" | "contradicts" | "supersedes" | "co_occurs";
  strength: number;
  reason: string;
  keywords: string[];
}

export interface ExperienceGraphResponse {
  generatedAt: number;
  totalExperiences: number;
  nodes: ExperienceGraphNode[];
  links: ExperienceGraphLink[];
}

export interface ExperienceMaintenanceResult {
  inspected: number;
  groups: Array<{
    primaryId: string;
    duplicateIds: string[];
    mergedKeywords: string[];
    reason: string;
  }>;
  merged: number;
  deleted: number;
}
