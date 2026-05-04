export interface RelationshipsGraphQuery {
  search?: string;
  platform?: string;
  limit?: number;
  offset?: number;
  scope?: "all" | "relevant";
}

export interface RelationshipsIdentityHandle {
  entityId: string;
  platform: string;
  handle: string;
  status?: string | null;
  verified?: boolean | null;
}

export interface RelationshipsIdentitySummary {
  entityId: string;
  names: string[];
  platforms: string[];
  handles: RelationshipsIdentityHandle[];
}

export interface RelationshipsProfile {
  entityId: string;
  source: string;
  handle?: string | null;
  userId?: string | null;
  displayName?: string | null;
  avatarUrl?: string | null;
  canonical?: boolean | null;
}

export interface RelationshipsPersonSummary {
  groupId: string;
  primaryEntityId: string;
  memberEntityIds: string[];
  displayName: string;
  aliases: string[];
  platforms: string[];
  identities: RelationshipsIdentitySummary[];
  emails: string[];
  phones: string[];
  websites: string[];
  preferredCommunicationChannel: string | null;
  categories: string[];
  tags: string[];
  factCount: number;
  relationshipCount: number;
  isOwner: boolean;
  profiles: RelationshipsProfile[];
  lastInteractionAt?: string;
}

export interface RelationshipsPersonFact {
  id: string;
  sourceType: "claim" | "contact" | "memory";
  text: string;
  field?: string;
  value?: string;
  scope?: string;
  confidence?: number;
  updatedAt?: string;
  /** ISO8601 timestamp from FactRefinementEvaluator metadata. */
  lastReinforced?: string;
  /** Message IDs that contributed evidence to this fact. */
  evidenceMessageIds?: string[];
  provenance?: RelationshipsFactProvenance;
  extractedInformation?: RelationshipsFactExtractedInformation;
}

export interface RelationshipsFactProvenance {
  source?: string;
  evaluatorName?: string;
  sourceTrajectoryId?: string;
  lastReinforced?: string;
  evidenceMessageIds: string[];
}

export interface RelationshipsFactExtractedInformation {
  scope?: string;
  raw?: Record<string, unknown>;
}

export interface RelationshipsRelevantMemory {
  id: string;
  sourceType: "message";
  entityId?: string;
  roomId?: string;
  roomName: string | null;
  speaker: string;
  text: string;
  createdAt?: string;
  source?: string | null;
}

export interface RelationshipsConversationMessage {
  id: string;
  entityId?: string;
  speaker: string;
  text: string;
  createdAt?: number;
}

export interface RelationshipsConversationSnippet {
  roomId: string;
  roomName: string;
  lastActivityAt?: string;
  messages: RelationshipsConversationMessage[];
}

export interface RelationshipsGraphEdge {
  id: string;
  sourcePersonId: string;
  targetPersonId: string;
  sourcePersonName: string;
  targetPersonName: string;
  relationshipTypes: string[];
  sentiment: string;
  strength: number;
  interactionCount: number;
  lastInteractionAt?: string;
  rawRelationshipIds: string[];
}

export interface RelationshipsIdentityEdge {
  id: string;
  sourceEntityId: string;
  targetEntityId: string;
  confidence: number;
  status: string;
}

export interface RelationshipsPersonDetail extends RelationshipsPersonSummary {
  facts: RelationshipsPersonFact[];
  recentConversations: RelationshipsConversationSnippet[];
  relevantMemories: RelationshipsRelevantMemory[];
  relationships: RelationshipsGraphEdge[];
  identityEdges: RelationshipsIdentityEdge[];
  userPersonalityPreferences: RelationshipsUserPersonalityPreference[];
}

export interface RelationshipsUserPersonalityPreference {
  id: string;
  entityId: string;
  text: string;
  category?: string;
  originalRequest?: string;
  source?: string | null;
  createdAt?: string;
}

export interface RelationshipsGraphStats {
  totalPeople: number;
  totalRelationships: number;
  totalIdentities: number;
}

export interface RelationshipsMergeCandidateEvidence {
  platform?: string;
  handle?: string;
  notes?: string;
  identityIds?: string[];
}

export interface RelationshipsMergeCandidate {
  id: string;
  entityA: string;
  entityB: string;
  confidence: number;
  evidence: RelationshipsMergeCandidateEvidence;
  status: "pending" | "accepted" | "rejected";
  proposedAt: string;
  resolvedAt?: string;
}

export interface RelationshipsGraphSnapshot {
  people: RelationshipsPersonSummary[];
  relationships: RelationshipsGraphEdge[];
  stats: RelationshipsGraphStats;
  candidateMerges: RelationshipsMergeCandidate[];
}

export interface RelationshipsActivityItem {
  type: "relationship" | "identity" | "fact";
  personName: string;
  personId: string;
  summary: string;
  detail: string | null;
  timestamp: string | null;
}

export interface RelationshipsActivityResponse {
  activity: RelationshipsActivityItem[];
  total: number;
  count: number;
  offset: number;
  limit: number;
  hasMore: boolean;
}
