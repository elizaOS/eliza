/** LifeOps relationships contracts. Persisted and wire shapes are preserved. */
import type { LifeOpsCrossChannelDraft } from "./inbox.js";

// ── Follow-up statuses ───────────────────────────────────────────────────────

export const LIFEOPS_FOLLOW_UP_STATUSES = [
  "pending",
  "completed",
  "snoozed",
  "cancelled",
] as const;

export type LifeOpsFollowUpStatus = (typeof LIFEOPS_FOLLOW_UP_STATUSES)[number];

// Note: `LIFEOPS_NEGOTIATION_STATES`, `LifeOpsNegotiationState`,
// `LifeOpsSchedulingNegotiation`, and `LifeOpsSchedulingProposal` are
// declared in the canonical `./lifeops.ts` contracts file, not here.

// ── Relationship ─────────────────────────────────────────────────────────────

export interface LifeOpsRelationship {
  id: string;
  agentId: string;
  name: string;
  primaryChannel: string;
  primaryHandle: string;
  email: string | null;
  phone: string | null;
  notes: string;
  tags: string[];
  relationshipType: string;
  lastContactedAt: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface LifeOpsRelationshipInteraction {
  id: string;
  agentId: string;
  relationshipId: string;
  channel: string;
  direction: "inbound" | "outbound";
  summary: string;
  occurredAt: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface LifeOpsFollowUp {
  id: string;
  agentId: string;
  relationshipId: string;
  dueAt: string;
  reason: string;
  status: LifeOpsFollowUpStatus;
  priority: number;
  draft: LifeOpsCrossChannelDraft | null;
  completedAt: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}
