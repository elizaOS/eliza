/**
 * Durable monthly family-coordination packets project existing LifeOps facts
 * into an owner-internal aggregate and a separately versioned, guest-shareable
 * draft. Drafting is deterministic, provenance-preserving, expense-free, and
 * can only enter the canonical approval queue; this module never dispatches it.
 */

import { createHash } from "node:crypto";
import { ElizaError, type IAgentRuntime } from "@elizaos/core";
import type {
  ApprovalQueue,
  ApprovalRequest,
} from "../approval-queue.types.js";
import {
  executeRawSql,
  executeRawSqlTx,
  parseJsonArray,
  parseJsonValue,
  sqlQuote,
  toNumber,
  toText,
  withRequiredTransaction,
} from "../sql.js";

export const FAMILY_PACKET_VERSION = 1 as const;

export const FAMILY_PACKET_SECTIONS = [
  "custody_calendar",
  "school",
  "approved_obligations",
  "travel_consent_health",
  "unanswered",
] as const;

export type FamilyPacketSection = (typeof FAMILY_PACKET_SECTIONS)[number];
export type FamilyPacketVisibility = "owner_only" | "guest_shareable";

export interface FamilyPacketProvenance {
  readonly source:
    | "household"
    | "calendar"
    | "school"
    | "agreement"
    | "knowledge";
  readonly sourceId: string;
  readonly observedAt: string;
  readonly contentSha256: string;
}

export interface FamilyPacketClaim {
  readonly claimId: string;
  readonly stableKey: string;
  readonly section: FamilyPacketSection;
  readonly statement: string;
  readonly visibility: FamilyPacketVisibility;
  readonly provenance: readonly FamilyPacketProvenance[];
  readonly dates: readonly string[];
  readonly requests: readonly string[];
  readonly urgency: string | null;
  readonly commitments: readonly string[];
  readonly accountability: readonly string[];
  readonly obligationApprovalId?: string | null;
  readonly unanswered?: boolean;
  readonly carryForwardCount?: 0 | 1;
  readonly carriedFromClaimId?: string | null;
}

export interface FamilyPacketPeriod {
  readonly key: string;
  readonly startsOn: string;
  readonly endsOnExclusive: string;
  readonly timeZone: string;
}

export type FamilyPacketSectionState = "complete" | "missing" | "contradictory";

export interface FamilyPacketSectionSummary {
  readonly section: FamilyPacketSection;
  readonly state: FamilyPacketSectionState;
  readonly claimIds: readonly string[];
  readonly contradictoryKeys: readonly string[];
}

export interface MonthlyFamilyPacket {
  readonly schemaVersion: typeof FAMILY_PACKET_VERSION;
  readonly packetId: string;
  readonly agentId: string;
  readonly period: FamilyPacketPeriod;
  readonly version: number;
  readonly claims: readonly FamilyPacketClaim[];
  readonly sections: readonly FamilyPacketSectionSummary[];
  readonly contentSha256: string;
  readonly createdAt: string;
}

export interface FamilyPacketTransformation {
  readonly kind:
    | "private_claim_omitted"
    | "unapproved_obligation_omitted"
    | "contradiction_surfaced"
    | "missing_section_surfaced"
    | "unanswered_carried_once";
  readonly claimId: string | null;
  readonly detail: string;
}

export interface MonthlyFamilyDraft {
  readonly packetId: string;
  readonly internalVersion: number;
  readonly draftVersion: number;
  readonly recipient: string;
  readonly body: string;
  readonly bodySha256: string;
  readonly transformations: readonly FamilyPacketTransformation[];
  readonly createdAt: string;
}

const SCHEMA = [
  `CREATE SCHEMA IF NOT EXISTS app_lifeops`,
  `CREATE TABLE IF NOT EXISTS app_lifeops.life_family_packets (
    agent_id TEXT NOT NULL, packet_id TEXT NOT NULL, period_key TEXT NOT NULL,
    internal_version INTEGER NOT NULL, content_sha256 TEXT NOT NULL,
    packet_json TEXT NOT NULL, created_at TEXT NOT NULL,
    PRIMARY KEY (agent_id, packet_id, internal_version),
    UNIQUE (agent_id, period_key, internal_version)
  )`,
  `CREATE INDEX IF NOT EXISTS life_family_packets_period_idx
    ON app_lifeops.life_family_packets (agent_id, period_key, internal_version DESC)`,
  `CREATE TABLE IF NOT EXISTS app_lifeops.life_family_packet_drafts (
    agent_id TEXT NOT NULL, packet_id TEXT NOT NULL, internal_version INTEGER NOT NULL,
    draft_version INTEGER NOT NULL, recipient TEXT NOT NULL, body TEXT NOT NULL,
    body_sha256 TEXT NOT NULL, transformations_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (agent_id, packet_id, draft_version)
  )`,
  `CREATE TABLE IF NOT EXISTS app_lifeops.life_family_packet_approvals (
    agent_id TEXT NOT NULL, packet_id TEXT NOT NULL, draft_version INTEGER NOT NULL,
    draft_sha256 TEXT NOT NULL, approval_id TEXT NOT NULL, created_at TEXT NOT NULL,
    PRIMARY KEY (agent_id, packet_id, draft_version), UNIQUE (agent_id, approval_id)
  )`,
] as const;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stable(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function fail(message: string, code: string): never {
  throw new ElizaError(`[MonthlyFamilyPacket] ${message}`, {
    code,
    severity: "warn",
  });
}

function validatePeriod(period: FamilyPacketPeriod): void {
  if (!/^\d{4}-\d{2}$/.test(period.key))
    fail("invalid period key", "FAMILY_PACKET_PERIOD_INVALID");
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(period.startsOn) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(period.endsOnExclusive)
  ) {
    fail(
      "period boundaries must be explicit ISO dates",
      "FAMILY_PACKET_PERIOD_INVALID",
    );
  }
  if (
    period.startsOn >= period.endsOnExclusive ||
    period.timeZone.trim() === ""
  ) {
    fail(
      "period boundary or timezone is invalid",
      "FAMILY_PACKET_PERIOD_INVALID",
    );
  }
}

function validateClaim(claim: FamilyPacketClaim): void {
  if (!(FAMILY_PACKET_SECTIONS as readonly string[]).includes(claim.section)) {
    fail(
      "unsupported section; expenses are excluded",
      "FAMILY_PACKET_EXPENSE_FORBIDDEN",
    );
  }
  const raw = claim as FamilyPacketClaim & { dataClass?: string };
  if (raw.dataClass === "expense")
    fail("expense claims are forbidden", "FAMILY_PACKET_EXPENSE_FORBIDDEN");
  if (
    !claim.claimId ||
    !claim.stableKey ||
    !claim.statement ||
    claim.provenance.length === 0
  ) {
    fail(
      "claim and provenance fields are required",
      "FAMILY_PACKET_CLAIM_INVALID",
    );
  }
  for (const source of claim.provenance) {
    if (
      !source.sourceId ||
      !/^\d{4}-\d{2}-\d{2}T/.test(source.observedAt) ||
      !/^[a-f0-9]{64}$/.test(source.contentSha256)
    ) {
      fail(
        "claim provenance is incomplete",
        "FAMILY_PACKET_PROVENANCE_INVALID",
      );
    }
  }
  if (claim.section === "approved_obligations" && !claim.obligationApprovalId) {
    // Allowed internally, but it can never enter the external draft.
    return;
  }
}

function summarizeSections(
  claims: readonly FamilyPacketClaim[],
): FamilyPacketSectionSummary[] {
  return FAMILY_PACKET_SECTIONS.map((section) => {
    const selected = claims.filter((claim) => claim.section === section);
    const groups = new Map<string, Set<string>>();
    for (const claim of selected) {
      const values = groups.get(claim.stableKey) ?? new Set<string>();
      values.add(
        sha256(
          stable({
            statement: claim.statement,
            dates: claim.dates,
            requests: claim.requests,
            urgency: claim.urgency,
            commitments: claim.commitments,
            accountability: claim.accountability,
          }),
        ),
      );
      groups.set(claim.stableKey, values);
    }
    const contradictoryKeys = [...groups.entries()]
      .filter(([, values]) => values.size > 1)
      .map(([key]) => key)
      .sort();
    return {
      section,
      state:
        selected.length === 0
          ? "missing"
          : contradictoryKeys.length > 0
            ? "contradictory"
            : "complete",
      claimIds: selected.map((claim) => claim.claimId).sort(),
      contradictoryKeys,
    };
  });
}

function parsePacket(row: Record<string, unknown>): MonthlyFamilyPacket {
  return parseJsonValue<MonthlyFamilyPacket>(row.packet_json, null as never);
}

export class MonthlyFamilyPacketService {
  private initialized = false;

  constructor(
    private readonly runtime: IAgentRuntime,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private async ensureSchema(): Promise<void> {
    if (this.initialized) return;
    for (const statement of SCHEMA)
      await executeRawSql(this.runtime, statement);
    this.initialized = true;
  }

  async latest(periodKey: string): Promise<MonthlyFamilyPacket | null> {
    await this.ensureSchema();
    const rows = await executeRawSql(
      this.runtime,
      `SELECT packet_json FROM app_lifeops.life_family_packets WHERE agent_id=${sqlQuote(this.runtime.agentId)} AND period_key=${sqlQuote(periodKey)} ORDER BY internal_version DESC LIMIT 1`,
    );
    return rows[0] ? parsePacket(rows[0]) : null;
  }

  private async previous(
    periodKey: string,
  ): Promise<MonthlyFamilyPacket | null> {
    const rows = await executeRawSql(
      this.runtime,
      `SELECT packet_json FROM app_lifeops.life_family_packets WHERE agent_id=${sqlQuote(this.runtime.agentId)} AND period_key < ${sqlQuote(periodKey)} ORDER BY period_key DESC, internal_version DESC LIMIT 1`,
    );
    return rows[0] ? parsePacket(rows[0]) : null;
  }

  async buildInternal(
    period: FamilyPacketPeriod,
    incoming: readonly FamilyPacketClaim[],
  ): Promise<MonthlyFamilyPacket> {
    await this.ensureSchema();
    validatePeriod(period);
    incoming.forEach(validateClaim);
    const prior = await this.previous(period.key);
    const currentKeys = new Set(incoming.map((claim) => claim.stableKey));
    const carried = (prior?.claims ?? [])
      .filter(
        (claim) =>
          claim.unanswered === true &&
          (claim.carryForwardCount ?? 0) === 0 &&
          !currentKeys.has(claim.stableKey),
      )
      .map(
        (claim): FamilyPacketClaim => ({
          ...claim,
          claimId: `${claim.claimId}:carry:${period.key}`,
          carryForwardCount: 1,
          carriedFromClaimId: claim.claimId,
        }),
      );
    const claims = [...incoming, ...carried].sort((a, b) =>
      a.claimId.localeCompare(b.claimId),
    );
    const core = {
      schemaVersion: FAMILY_PACKET_VERSION,
      agentId: this.runtime.agentId,
      period,
      claims,
      sections: summarizeSections(claims),
    };
    const contentSha256 = sha256(stable(core));
    const latest = await this.latest(period.key);
    if (latest?.contentSha256 === contentSha256) return latest;
    const version = (latest?.version ?? 0) + 1;
    const packetId =
      latest?.packetId ?? `family-packet:${this.runtime.agentId}:${period.key}`;
    const packet: MonthlyFamilyPacket = {
      ...core,
      packetId,
      version,
      contentSha256,
      createdAt: this.now().toISOString(),
    };
    await executeRawSql(
      this.runtime,
      `INSERT INTO app_lifeops.life_family_packets (agent_id,packet_id,period_key,internal_version,content_sha256,packet_json,created_at) VALUES (${sqlQuote(this.runtime.agentId)},${sqlQuote(packetId)},${sqlQuote(period.key)},${version},${sqlQuote(contentSha256)},${sqlQuote(JSON.stringify(packet))},${sqlQuote(packet.createdAt)})`,
    );
    return packet;
  }

  async createExternalDraft(
    packet: MonthlyFamilyPacket,
    recipient: string,
  ): Promise<MonthlyFamilyDraft> {
    await this.ensureSchema();
    const current = await this.latest(packet.period.key);
    if (
      !current ||
      current.packetId !== packet.packetId ||
      current.version !== packet.version ||
      current.contentSha256 !== packet.contentSha256
    ) {
      fail(
        "internal packet is stale or tampered",
        "FAMILY_PACKET_INTERNAL_STALE",
      );
    }
    if (!recipient.trim())
      fail("recipient is required", "FAMILY_PACKET_RECIPIENT_INVALID");
    const transformations: FamilyPacketTransformation[] = [];
    const shareable = packet.claims.filter((claim) => {
      if (claim.visibility !== "guest_shareable") {
        transformations.push({
          kind: "private_claim_omitted",
          claimId: claim.claimId,
          detail: "Owner-only claim omitted from external draft.",
        });
        return false;
      }
      if (
        claim.section === "approved_obligations" &&
        !claim.obligationApprovalId
      ) {
        transformations.push({
          kind: "unapproved_obligation_omitted",
          claimId: claim.claimId,
          detail: "Obligation notice omitted until approved.",
        });
        return false;
      }
      if (claim.carriedFromClaimId)
        transformations.push({
          kind: "unanswered_carried_once",
          claimId: claim.claimId,
          detail: `Unanswered item carried once from ${claim.carriedFromClaimId}.`,
        });
      return true;
    });
    const lines = [
      `Family coordination for ${packet.period.startsOn} through ${packet.period.endsOnExclusive} (${packet.period.timeZone})`,
      "",
    ];
    for (const summary of summarizeSections(shareable)) {
      lines.push(`## ${summary.section.replaceAll("_", " ")}`);
      const claims = shareable.filter(
        (claim) => claim.section === summary.section,
      );
      if (claims.length === 0) {
        lines.push("Missing: no shareable information is available.", "");
        transformations.push({
          kind: "missing_section_surfaced",
          claimId: null,
          detail: `${summary.section} has no shareable claims.`,
        });
        continue;
      }
      if (summary.state === "contradictory") {
        lines.push(
          `Needs resolution: contradictory sources for ${summary.contradictoryKeys.join(", ")}.`,
        );
        transformations.push({
          kind: "contradiction_surfaced",
          claimId: null,
          detail: `${summary.section}: ${summary.contradictoryKeys.join(", ")}`,
        });
      }
      for (const claim of claims) {
        lines.push(`- ${claim.statement}`);
        if (claim.dates.length)
          lines.push(`  Dates: ${claim.dates.join("; ")}`);
        if (claim.requests.length)
          lines.push(`  Requests: ${claim.requests.join("; ")}`);
        if (claim.urgency) lines.push(`  Urgency: ${claim.urgency}`);
        if (claim.commitments.length)
          lines.push(`  Commitments: ${claim.commitments.join("; ")}`);
        if (claim.accountability.length)
          lines.push(`  Accountability: ${claim.accountability.join("; ")}`);
        lines.push(
          `  Sources: ${claim.provenance.map((source) => `${source.source}:${source.sourceId}@${source.observedAt}#${source.contentSha256}`).join("; ")}`,
        );
      }
      lines.push("");
    }
    const body = lines.join("\n").trimEnd();
    for (const claim of packet.claims.filter(
      (entry) => entry.visibility === "owner_only",
    )) {
      if (body.includes(claim.statement))
        fail("owner-only content leaked", "FAMILY_PACKET_PRIVACY_LEAK");
    }
    const rows = await executeRawSql(
      this.runtime,
      `SELECT COALESCE(MAX(draft_version),0) AS version FROM app_lifeops.life_family_packet_drafts WHERE agent_id=${sqlQuote(this.runtime.agentId)} AND packet_id=${sqlQuote(packet.packetId)}`,
    );
    const draftVersion = toNumber(rows[0]?.version) + 1;
    const draft: MonthlyFamilyDraft = {
      packetId: packet.packetId,
      internalVersion: packet.version,
      draftVersion,
      recipient,
      body,
      bodySha256: sha256(body),
      transformations,
      createdAt: this.now().toISOString(),
    };
    await executeRawSql(
      this.runtime,
      `INSERT INTO app_lifeops.life_family_packet_drafts (agent_id,packet_id,internal_version,draft_version,recipient,body,body_sha256,transformations_json,created_at) VALUES (${sqlQuote(this.runtime.agentId)},${sqlQuote(packet.packetId)},${packet.version},${draftVersion},${sqlQuote(recipient)},${sqlQuote(body)},${sqlQuote(draft.bodySha256)},${sqlQuote(JSON.stringify(transformations))},${sqlQuote(draft.createdAt)})`,
    );
    return draft;
  }

  async enqueueDraftApproval(args: {
    draft: MonthlyFamilyDraft;
    queue: Pick<
      ApprovalQueue,
      "enqueueTransactional" | "surfaceEnqueuedApproval"
    >;
    requestedBy: string;
    subjectUserId: string;
    expiresAt: Date;
  }): Promise<ApprovalRequest> {
    await this.ensureSchema();
    const draft = await this.readDraft(
      args.draft.packetId,
      args.draft.draftVersion,
    );
    if (
      !draft ||
      draft.bodySha256 !== args.draft.bodySha256 ||
      draft.body !== args.draft.body ||
      draft.recipient !== args.draft.recipient
    ) {
      fail("draft is missing or tampered", "FAMILY_PACKET_DRAFT_TAMPERED");
    }
    const latestRows = await executeRawSql(
      this.runtime,
      `SELECT MAX(draft_version) AS version FROM app_lifeops.life_family_packet_drafts WHERE agent_id=${sqlQuote(this.runtime.agentId)} AND packet_id=${sqlQuote(draft.packetId)}`,
    );
    if (toNumber(latestRows[0]?.version) !== draft.draftVersion)
      fail("draft approval is stale", "FAMILY_PACKET_DRAFT_STALE");
    const request = await withRequiredTransaction(this.runtime, async (tx) => {
      const enqueued = await args.queue.enqueueTransactional(
        {
          requestedBy: args.requestedBy,
          subjectUserId: args.subjectUserId,
          action: "send_message",
          payload: {
            action: "send_message",
            recipient: draft.recipient,
            body: draft.body,
            replyToMessageId: null,
          },
          channel: "internal",
          reason: `Review monthly family coordination packet ${draft.packetId} draft ${draft.draftVersion}`,
          idempotencyKey: `family-packet:${draft.packetId}:draft:${draft.draftVersion}:${draft.bodySha256}`,
          expiresAt: args.expiresAt,
        },
        tx,
      );
      const approval = enqueued.request;
      if (
        approval.action !== "send_message" ||
        approval.payload.action !== "send_message" ||
        sha256(approval.payload.body) !== draft.bodySha256 ||
        approval.payload.recipient !== draft.recipient
      ) {
        fail(
          "approval payload does not match the immutable draft",
          "FAMILY_PACKET_APPROVAL_TAMPERED",
        );
      }
      await executeRawSqlTx(
        tx,
        `INSERT INTO app_lifeops.life_family_packet_approvals (agent_id,packet_id,draft_version,draft_sha256,approval_id,created_at) VALUES (${sqlQuote(this.runtime.agentId)},${sqlQuote(draft.packetId)},${draft.draftVersion},${sqlQuote(draft.bodySha256)},${sqlQuote(approval.id)},${sqlQuote(this.now().toISOString())}) ON CONFLICT (agent_id,packet_id,draft_version) DO UPDATE SET draft_sha256=EXCLUDED.draft_sha256,approval_id=EXCLUDED.approval_id,created_at=EXCLUDED.created_at`,
      );
      return approval;
    });
    await args.queue.surfaceEnqueuedApproval(request);
    return request;
  }

  async validateApprovedDraft(
    request: ApprovalRequest,
  ): Promise<MonthlyFamilyDraft> {
    await this.ensureSchema();
    if (
      request.state !== "approved" ||
      request.action !== "send_message" ||
      request.payload.action !== "send_message"
    )
      fail(
        "approval is not an approved message",
        "FAMILY_PACKET_APPROVAL_INVALID",
      );
    const rows = await executeRawSql(
      this.runtime,
      `SELECT packet_id,draft_version,draft_sha256 FROM app_lifeops.life_family_packet_approvals WHERE agent_id=${sqlQuote(this.runtime.agentId)} AND approval_id=${sqlQuote(request.id)} LIMIT 1`,
    );
    const binding = rows[0];
    if (!binding)
      fail(
        "approval is not bound to a packet draft",
        "FAMILY_PACKET_APPROVAL_INVALID",
      );
    const draft = await this.readDraft(
      toText(binding.packet_id),
      toNumber(binding.draft_version),
    );
    if (
      !draft ||
      draft.bodySha256 !== toText(binding.draft_sha256) ||
      sha256(request.payload.body) !== draft.bodySha256 ||
      request.payload.recipient !== draft.recipient
    )
      fail("approved payload was tampered", "FAMILY_PACKET_APPROVAL_TAMPERED");
    const latestRows = await executeRawSql(
      this.runtime,
      `SELECT MAX(draft_version) AS version FROM app_lifeops.life_family_packet_drafts WHERE agent_id=${sqlQuote(this.runtime.agentId)} AND packet_id=${sqlQuote(draft.packetId)}`,
    );
    if (toNumber(latestRows[0]?.version) !== draft.draftVersion)
      fail("approved draft is stale", "FAMILY_PACKET_APPROVAL_STALE");
    return draft;
  }

  private async readDraft(
    packetId: string,
    version: number,
  ): Promise<MonthlyFamilyDraft | null> {
    const rows = await executeRawSql(
      this.runtime,
      `SELECT * FROM app_lifeops.life_family_packet_drafts WHERE agent_id=${sqlQuote(this.runtime.agentId)} AND packet_id=${sqlQuote(packetId)} AND draft_version=${version} LIMIT 1`,
    );
    const row = rows[0];
    if (!row) return null;
    return {
      packetId: toText(row.packet_id),
      internalVersion: toNumber(row.internal_version),
      draftVersion: toNumber(row.draft_version),
      recipient: toText(row.recipient),
      body: toText(row.body),
      bodySha256: toText(row.body_sha256),
      transformations: parseJsonArray<FamilyPacketTransformation>(
        row.transformations_json,
      ),
      createdAt: toText(row.created_at),
    };
  }
}
