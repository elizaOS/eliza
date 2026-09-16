/** Constructs and parses brief engagement ledger records and deterministic reward identifiers. */

import crypto from "node:crypto";
import type {
  LifeOpsBriefEngagementEventType,
  LifeOpsBriefItemKind,
  LifeOpsBriefItemSource,
} from "../briefing/editorial-judgment.js";
import { parseJsonRecord, toNumber, toText } from "../sql.js";

export interface LifeOpsBriefItemEngagementRecord {
  id: string;
  agentId: string;
  briefingId: string;
  itemId: string;
  source: LifeOpsBriefItemSource;
  kind: LifeOpsBriefItemKind;
  sourceId: string;
  itemClass: string;
  eventType: LifeOpsBriefEngagementEventType;
  eventAt: string;
  weight: number;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export type LifeOpsBriefItemEngagementWrite = Omit<
  LifeOpsBriefItemEngagementRecord,
  "id" | "createdAt"
> & {
  id?: string;
  createdAt?: string;
};

export function briefRewardMarkerId(
  agentId: string,
  engagementId: string,
): string {
  return `brief_reward_${crypto
    .createHash("sha256")
    .update([agentId, engagementId].join("\0"))
    .digest("hex")
    .slice(0, 20)}`;
}

export function parseBriefItemEngagement(
  row: Record<string, unknown>,
): LifeOpsBriefItemEngagementRecord {
  return {
    id: toText(row.id),
    agentId: toText(row.agent_id),
    briefingId: toText(row.briefing_id),
    itemId: toText(row.item_id),
    source: toText(row.source) as LifeOpsBriefItemSource,
    kind: toText(row.kind) as LifeOpsBriefItemKind,
    sourceId: toText(row.source_id),
    itemClass: toText(row.item_class),
    eventType: toText(row.event_type) as LifeOpsBriefEngagementEventType,
    eventAt: toText(row.event_at),
    weight: toNumber(row.weight),
    metadata: parseJsonRecord(row.metadata_json),
    createdAt: toText(row.created_at),
  };
}
