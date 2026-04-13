/**
 * Rolodex Benchmark Types — v2 (realistic)
 *
 * Entity IDs are opaque (ent_d1, ent_w2, etc). Display names are realistic
 * handles (d4v3_builds, WhaleAlert42). The handler never sees the canonical
 * person — only the scorer does.
 */

// ── Ground Truth ─────────────────────────────

export interface WorldEntity {
  id: string;                 // opaque: "ent_d1"
  canonicalPerson: string;    // "dave" — ONLY for scoring. handler never sees this.
  displayName: string;        // what appears in chat: "d4v3_builds"
  platform: string;           // "discord" | "twitter" | "telegram"
  /** The handle on THIS platform (ground truth from platform API) */
  platformHandle: string;     // "d4v3_builds" or "@chaintrack3r"
  attributes: Record<string, string>;
}

export interface GroundTruthLink {
  entityA: string;            // opaque entity ID
  entityB: string;
  difficulty: 'easy' | 'medium' | 'hard';
  reason: string;
  expectedSignals: string[];
}

export interface AntiLink {
  entityA: string;
  entityB: string;
  reason: string;
}

export interface GroundTruthWorld {
  entities: WorldEntity[];
  links: GroundTruthLink[];
  antiLinks: AntiLink[];
}

// ── Conversations ────────────────────────────

export interface Message {
  from: string;               // opaque entity ID
  displayName: string;        // visible handle
  text: string;
  platform: string;
  room: string;
}

export interface Conversation {
  id: string;
  name: string;
  platform: string;
  room: string;
  messages: Message[];
  expected: {
    identities: Array<{ entityId: string; platform: string; handle: string }>;
    relationships: Array<{ entityA: string; entityB: string; type: string; sentiment: string }>;
    trustSignals: Array<{ entityId: string; signal: string }>;
  };
}

// ── Handler ──────────────────────────────────

export interface Handler {
  name: string;
  /** Optional async setup (e.g. initializing an AgentRuntime). */
  setup?(): Promise<void>;
  /** Optional async teardown (e.g. stopping an AgentRuntime). */
  teardown?(): Promise<void>;
  extract(conv: Conversation, world: GroundTruthWorld): Extraction | Promise<Extraction>;
  resolve(extractions: Extraction[], world: GroundTruthWorld): Resolution | Promise<Resolution>;
}

export interface Extraction {
  conversationId: string;
  identities: Array<{ entityId: string; platform: string; handle: string }>;
  relationships: Array<{ entityA: string; entityB: string; type: string; sentiment: string }>;
  trustSignals: Array<{ entityId: string; signal: string }>;
  traces: string[];
  wallTimeMs: number;
}

export interface Resolution {
  links: Array<{ entityA: string; entityB: string; confidence: number; signals: string[] }>;
  traces: string[];
  wallTimeMs: number;
}

// ── Scoring ──────────────────────────────────

export interface Metrics {
  tp: number; fp: number; fn: number;
  precision: number; recall: number; f1: number;
}

export interface ItemTrace {
  status: 'TP' | 'FP' | 'FN' | 'PARTIAL';
  label: string;
  detail: string;
}

export interface RelationshipMetrics extends Metrics {
  typeAccuracy: number;  // of matched pairs, how many got the type right?
}
