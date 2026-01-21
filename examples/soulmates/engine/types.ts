export type IsoDateTime = string;

export type DomainMode = "general" | "business" | "dating" | "friendship";
export type PersonaStatus = "active" | "paused" | "blocked" | "pending";

export type MatchStatus =
  | "proposed"
  | "accepted"
  | "scheduled"
  | "completed"
  | "canceled"
  | "expired";
export type MeetingStatus = "scheduled" | "completed" | "no_show" | "canceled";

export type FeedbackSentiment = "positive" | "neutral" | "negative";
export type FeedbackSource =
  | "meeting"
  | "group_event"
  | "conversation"
  | "admin";
export type FeedbackIssueSeverity = "low" | "medium" | "high" | "critical";

export type SafetySeverity = "level1" | "level2" | "level3";

export type MessageChannel = "whatsapp" | "sms" | "email";
export type MessageDirection = "inbound" | "outbound";
export type MessageStatus = "sent" | "delivered" | "failed";

export type Cadence = "weekly" | "biweekly" | "monthly" | "flexible";
export type DayOfWeek = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";

export type Build = "thin" | "fit" | "average" | "above_average" | "overweight";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject {
  [key: string]: JsonValue;
}

export type PersonaId = number;

export interface GeoPoint {
  lat: number;
  lng: number;
}

export interface Location {
  city: string;
  country: string;
  neighborhood?: string;
  timeZone: string;
  geo?: GeoPoint;
}

export interface AvailabilityWindow {
  day: DayOfWeek;
  startMinutes: number;
  endMinutes: number;
}

export interface AvailabilityException {
  date: string;
  startMinutes?: number;
  endMinutes?: number;
  unavailable?: boolean;
  reason?: string;
}

export interface Availability {
  timeZone: string;
  weekly: AvailabilityWindow[];
  exceptions: AvailabilityException[];
}

export interface ReliabilityEvent {
  eventId: string;
  type: "attended" | "late_cancel" | "no_show" | "ghost" | "on_time";
  occurredAt: IsoDateTime;
  impact: number;
  notes?: string;
}

export interface ReliabilitySignals {
  score: number;
  lastUpdated: IsoDateTime;
  attendedCount: number;
  lateCancelCount: number;
  noShowCount: number;
  ghostCount: number;
  ghostedByOthersCount: number;
  canceledOnByOthersCount: number;
  responseLatencyAvgMinutes: number;
  history: ReliabilityEvent[];
}

export interface FeedbackSummary {
  sentimentScore: number;
  positiveCount: number;
  neutralCount: number;
  negativeCount: number;
  lastUpdated: IsoDateTime;
  redFlagTags: string[];
  issueTags: string[];
}

export interface FeedbackRaterStats {
  givenCount: number;
  averageRating: number;
  negativeRate: number;
  redFlagRate: number;
  lastUpdated: IsoDateTime;
}

export interface FeedbackRaterBias {
  harshnessScore: number;
  positivityBias: number;
  redFlagFrequency: number;
  notes: string[];
  stats: FeedbackRaterStats;
  lastUpdated: IsoDateTime;
}

export interface ProfileCore {
  name: string;
  pronouns: string;
  availability: Availability;
  interests: string[];
  meetingCadence: Cadence;
  connectionGoals: string[];
  communityTags: string[];
  feedbackSummary: FeedbackSummary;
}

export interface GeneralProfile {
  name: string;
  age: number;
  genderIdentity: string;
  pronouns: string;
  location: Location;
  values: string[];
  education?: string;
  bio: string;
}

export interface AppearanceProfile {
  attractiveness: number;
  build: Build;
  hairColor: string;
  eyeColor: string;
  skinTone: number;
  ethnicity: string;
  perceivedGender: number;
  distinctiveFeatures: string[];
}

export interface AttractivenessAssessment {
  assessmentId: string;
  modelScore: number;
  eloRating?: number;
  notes: string[];
  assessedAt: IsoDateTime;
}

export interface AttractivenessProfile {
  appearance: AppearanceProfile;
  assessments: AttractivenessAssessment[];
}

export interface DatingPreferences {
  preferredGenders: string[];
  preferredAgeMin: number;
  preferredAgeMax: number;
  relationshipGoal: string;
  dealbreakers: string[];
  bodyTypePreferences: string[];
  attractivenessImportance: number;
  fitnessImportance: number;
  orientation: string;
}

export interface DatingProfile {
  datingPreferences: DatingPreferences;
  attractionProfile: AttractivenessProfile;
  hobbies: string[];
  personalityTraits: string[];
  communicationStyle: string;
  lifestyle: string;
  relationshipGoal: string;
  schedule: string;
}

export interface BusinessProfile {
  jobTitle: string;
  industry: string;
  roles: string[];
  seekingRoles: string[];
  skills: string[];
  experienceYears: number;
  companyStage: string;
  commitment: string;
  values: string[];
}

export interface FriendshipProfile {
  vibe: string;
  energy: string;
  socialStyle: string;
  interests: string[];
  hobbies: string[];
  boundaries: string[];
}

export interface DomainProfiles {
  dating?: DatingProfile;
  business?: BusinessProfile;
  friendship?: FriendshipProfile;
}

export interface FactEvidence {
  conversationId: string;
  turnIds: string[];
}

export type FactStatus = "active" | "superseded" | "retracted";
export type FactValue =
  | string
  | number
  | boolean
  | string[]
  | number[]
  | boolean[];

export interface Fact {
  factId: string;
  type: string;
  key: string;
  value: FactValue;
  confidence: number;
  evidence: FactEvidence[];
  status: FactStatus;
  createdAt: IsoDateTime;
  updatedAt?: IsoDateTime;
}

export type ConversationRole = "agent" | "user";

export interface ConversationTurn {
  turnId: string;
  role: ConversationRole;
  text: string;
  createdAt: IsoDateTime;
}

export interface Conversation {
  conversationId: string;
  scenario: string;
  turns: ConversationTurn[];
  processed: boolean;
  processedAt?: IsoDateTime;
}

export interface MatchPreferences {
  blockedPersonaIds: PersonaId[];
  excludedPersonaIds: PersonaId[];
  preferredAgeMin?: number;
  preferredAgeMax?: number;
  preferredGenders?: string[];
  bodyTypePreferences?: string[];
  reliabilityMinScore?: number;
}

export interface Persona {
  id: PersonaId;
  status: PersonaStatus;
  domains: DomainMode[];
  general: GeneralProfile;
  profile: ProfileCore;
  domainProfiles: DomainProfiles;
  matchPreferences: MatchPreferences;
  reliability: ReliabilitySignals;
  feedbackBias: FeedbackRaterBias;
  facts: Fact[];
  conversations: Conversation[];
  blockedPersonaIds: PersonaId[];
  lastUpdated: IsoDateTime;
  profileRevision: number;
  /** Optional priority boost (0-100) for credit-based queue jumping */
  priorityBoost?: number;
}

export interface FeedbackIssue {
  code: string;
  severity: FeedbackIssueSeverity;
  notes?: string;
  redFlag: boolean;
}

export interface FeedbackEntry {
  id: string;
  fromPersonaId: PersonaId;
  toPersonaId: PersonaId;
  meetingId?: string;
  rating: number;
  sentiment: FeedbackSentiment;
  issues: FeedbackIssue[];
  redFlags: string[];
  notes: string;
  createdAt: IsoDateTime;
  processed: boolean;
  processedAt?: IsoDateTime;
  source: FeedbackSource;
}

export interface MatchAssessment {
  score: number;
  smallPassScore?: number;
  largePassScore?: number;
  positiveReasons: string[];
  negativeReasons: string[];
  redFlags: string[];
}

export interface MatchRecord {
  matchId: string;
  domain: DomainMode;
  personaA: PersonaId;
  personaB: PersonaId;
  createdAt: IsoDateTime;
  status: MatchStatus;
  assessment: MatchAssessment;
  reasoning: string[];
  scheduledMeetingId?: string;
}

export interface MeetingLocation {
  name: string;
  address: string;
  city: string;
  placeId?: string;
  notes?: string;
}

export interface MeetingRecord {
  meetingId: string;
  matchId: string;
  scheduledAt: IsoDateTime;
  location: MeetingLocation;
  status: MeetingStatus;
  rescheduleCount: number;
  cancellationReason?: string;
}

export interface SafetyReport {
  reportId: string;
  reporterId: PersonaId;
  targetId: PersonaId;
  severity: SafetySeverity;
  notes: string;
  createdAt: IsoDateTime;
  status: "open" | "reviewing" | "resolved";
  transcriptRef?: string;
}

export interface CommunitySettings {
  cadence: Cadence;
  quietHours: string[];
  allowDomains: DomainMode[];
}

export interface Community {
  communityId: string;
  name: string;
  domain: DomainMode;
  settings: CommunitySettings;
}

export interface CreditLedgerEntry {
  entryId: string;
  personaId: PersonaId;
  type: "purchase" | "spend" | "grant";
  amount: number;
  reason: string;
  createdAt: IsoDateTime;
}

export interface MessageLog {
  messageId: string;
  personaId: PersonaId;
  direction: MessageDirection;
  channel: MessageChannel;
  text: string;
  createdAt: IsoDateTime;
  status: MessageStatus;
}

export interface MatchGraphEdge {
  from: PersonaId;
  to: PersonaId;
  weight: number;
  type: "match" | "feedback_positive" | "feedback_negative" | "met";
  createdAt: IsoDateTime;
}

export interface MatchGraph {
  edges: MatchGraphEdge[];
}

export interface EngineState {
  personas: Persona[];
  matches: MatchRecord[];
  meetings: MeetingRecord[];
  feedbackQueue: FeedbackEntry[];
  safetyReports: SafetyReport[];
  communities: Community[];
  credits: CreditLedgerEntry[];
  messages: MessageLog[];
  matchGraph: MatchGraph;
}

export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface SmallPassInput {
  persona: Persona;
  candidates: Persona[];
  domain: DomainMode;
  notes: string;
}

export interface SmallPassResult {
  rankedIds: PersonaId[];
  notes: string;
}

export interface LargePassInput {
  persona: Persona;
  candidate: Persona;
  domain: DomainMode;
  notes: string;
}

export interface LargePassResult {
  score: number;
  positiveReasons: string[];
  negativeReasons: string[];
  redFlags: string[];
  notes: string;
}

export interface LlmProvider {
  smallPass: (input: SmallPassInput) => Promise<SmallPassResult>;
  largePass: (input: LargePassInput) => Promise<LargePassResult>;
}

export interface LocationSuggestionRequest {
  city: string;
  interests: string[];
  timeOfDay: "morning" | "afternoon" | "evening";
  limit: number;
}

export interface LocationSuggestionProvider {
  suggest: (request: LocationSuggestionRequest) => Promise<MeetingLocation[]>;
}

export interface EngineOptions {
  now: IsoDateTime;
  batchSize: number;
  processFeedbackLimit?: number;
  processConversationLimit?: number;
  maxCandidates: number;
  smallPassTopK: number;
  largePassTopK: number;
  graphHops: number;
  matchCooldownDays: number;
  negativeFeedbackCooldownDays?: number;
  recentMatchWindow?: number;
  reliabilityWeight: number;
  minAvailabilityMinutes?: number;
  matchDomains: DomainMode[];
  targetPersonaIds?: PersonaId[];
  autoScheduleMatches?: boolean;
  requireSameCity?: boolean;
  requireSharedInterests?: boolean;
}

export interface EngineDependencies {
  llm?: LlmProvider;
  locationProvider?: LocationSuggestionProvider;
  idFactory?: () => string;
}

export interface EngineRunResult {
  state: EngineState;
  matchesCreated: MatchRecord[];
  feedbackProcessed: FeedbackEntry[];
  personasUpdated: Persona[];
}
