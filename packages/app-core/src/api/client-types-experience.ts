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
  confidence: number;
  importance: number;
  createdAt: number | string;
  updatedAt: number | string;
  lastAccessedAt?: number | string | null;
  accessCount: number;
  relatedExperiences?: string[];
  supersedes?: string | null;
  previousBelief?: string | null;
  correctedBelief?: string | null;
}

export interface ExperienceListResponse {
  experiences: ExperienceRecord[];
  total: number;
}

export interface ExperienceListQuery {
  limit?: number;
  offset?: number;
  type?: string | string[];
  outcome?: string | string[];
  domain?: string | string[];
  tags?: string[];
}

export interface ExperienceUpdateInput {
  learning?: string;
  importance?: number;
  confidence?: number;
  tags?: string[];
}
