/**
 * Deterministic owner calendar-card composition and single-use private access.
 * Card bytes stay in the canonical media store under an unservable private
 * filename; SQL retains only the access lifecycle and content identity.
 */

import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import {
  type IAgentRuntime,
  type IFileStorageService,
  ServiceType,
  stableStringify,
} from "@elizaos/core";
import type {
  ApprovalPayload,
  CalendarCardApprovalCorrelation,
} from "./approval-queue.types.js";
import { executeRawSql, sqlQuote, toText } from "./sql.js";

export type CalendarCardPrivacyMode = "full" | "times_only" | "busy_only";

export interface CalendarCardEvent {
  readonly id: string;
  readonly startAt: string;
  readonly endAt: string;
  readonly title: string;
  readonly location?: string | null;
}

export interface CalendarCardComposition {
  readonly version: 1;
  readonly date: string;
  readonly timeZone: string;
  readonly privacyMode: CalendarCardPrivacyMode;
  readonly html: string;
  readonly text: string;
  readonly htmlSha256: string;
  readonly textSha256: string;
  readonly envelopeSha256: string;
}

export type CalendarCardDeliveryStatus =
  | { state: "accepted"; providerReceipt: null; delivered: null }
  | {
      state: "provider_receipt";
      providerReceipt: Readonly<Record<string, unknown>>;
      delivered: null;
    }
  | {
      state: "delivered";
      providerReceipt: Readonly<Record<string, unknown>>;
      delivered: true;
    }
  | {
      state: "unknown";
      providerReceipt: Readonly<Record<string, unknown>> | null;
      delivered: null;
    };

export function calendarCardDeliveryStatus(args: {
  accepted: boolean;
  providerReceipt?: Readonly<Record<string, unknown>> | null;
  delivered?: boolean | null;
  outcomeUnknown?: boolean;
}): CalendarCardDeliveryStatus {
  const providerReceipt = args.providerReceipt ?? null;
  if (args.outcomeUnknown || !args.accepted) {
    return { state: "unknown", providerReceipt, delivered: null };
  }
  if (args.delivered === true && providerReceipt) {
    return { state: "delivered", providerReceipt, delivered: true };
  }
  if (providerReceipt) {
    return { state: "provider_receipt", providerReceipt, delivered: null };
  }
  return { state: "accepted", providerReceipt: null, delivered: null };
}

export class CalendarCardAccessError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "CARD_ACCESS_INVALID"
      | "CARD_ACCESS_WRONG_IDENTITY"
      | "CARD_ACCESS_EXPIRED"
      | "CARD_ACCESS_REVOKED"
      | "CARD_ACCESS_REPLAY"
      | "CARD_BYTES_MISSING"
      | "CARD_BYTES_TAMPERED",
    public readonly status: number,
  ) {
    super(message);
    this.name = "CalendarCardAccessError";
  }
}

const SCHEMA = [
  `CREATE SCHEMA IF NOT EXISTS app_lifeops`,
  `CREATE TABLE IF NOT EXISTS app_lifeops.life_calendar_card_access (
    agent_id TEXT NOT NULL, card_id TEXT NOT NULL, token_sha256 TEXT NOT NULL,
    recipient_entity_id TEXT NOT NULL, private_file_name TEXT NOT NULL,
    html_sha256 TEXT NOT NULL, expires_at TEXT NOT NULL, consumed_at TEXT,
    revoked_at TEXT, created_at TEXT NOT NULL,
    PRIMARY KEY (agent_id, card_id), UNIQUE (agent_id, token_sha256)
  )`,
  `CREATE INDEX IF NOT EXISTS life_calendar_card_access_expiry_idx
    ON app_lifeops.life_calendar_card_access (agent_id, expires_at)`,
] as const;

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function cardEnvelopeSha256(args: {
  date: string;
  timeZone: string;
  privacyMode: CalendarCardPrivacyMode;
  htmlSha256: string;
  textSha256: string;
}): string {
  return sha256(stableStringify({ version: 1, ...args }));
}

function equalDigest(left: string, right: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(left) || !/^[a-f0-9]{64}$/.test(right)) {
    return false;
  }
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function displayTime(value: string, timeZone: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp))
    throw new Error(`Invalid event time: ${value}`);
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(new Date(timestamp));
}

function visibleEvent(
  event: CalendarCardEvent,
  privacyMode: CalendarCardPrivacyMode,
): { time: string; title: string; location: string | null } {
  if (privacyMode === "busy_only") {
    return { time: "Busy", title: "Busy", location: null };
  }
  if (privacyMode === "times_only") {
    return { time: "", title: "Scheduled event", location: null };
  }
  return {
    time: "",
    title: event.title.trim() || "Untitled event",
    location: event.location?.trim() || null,
  };
}

export function composeDailyCalendarCard(args: {
  date: string;
  timeZone: string;
  privacyMode: CalendarCardPrivacyMode;
  events: readonly CalendarCardEvent[];
  accessUrl: string;
}): CalendarCardComposition {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(args.date))
    throw new Error("Invalid card date");
  const events = [...args.events].sort(
    (left, right) =>
      Date.parse(left.startAt) - Date.parse(right.startAt) ||
      left.id.localeCompare(right.id),
  );
  const rows = events.map((event) => {
    const visible = visibleEvent(event, args.privacyMode);
    const range = `${displayTime(event.startAt, args.timeZone)}–${displayTime(event.endAt, args.timeZone)}`;
    const label = args.privacyMode === "busy_only" ? visible.time : range;
    return `<li><time>${escapeHtml(label)}</time><strong>${escapeHtml(visible.title)}</strong>${visible.location ? `<span>${escapeHtml(visible.location)}</span>` : ""}</li>`;
  });
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Calendar for ${args.date}</title><style>body{margin:0;background:#fff7ed;color:#431407;font:16px system-ui;padding:24px}main{max-width:560px;margin:auto}h1{font-size:24px}ul{list-style:none;padding:0}li{display:grid;gap:4px;border-top:1px solid #fdba74;padding:14px 0}time{color:#9a3412;font-weight:700}span{color:#7c2d12}</style></head><body><main><h1>${escapeHtml(args.date)}</h1><ul>${rows.join("") || "<li><strong>No events</strong></li>"}</ul></main></body></html>`;
  const summary =
    events.length === 0
      ? `No events on ${args.date}.`
      : `${events.length} calendar event${events.length === 1 ? "" : "s"} on ${args.date}.`;
  const text = `${summary} View the private one-time calendar card: ${args.accessUrl}`;
  const htmlSha256 = sha256(Buffer.from(html, "utf8"));
  const textSha256 = sha256(Buffer.from(text, "utf8"));
  const envelopeSha256 = cardEnvelopeSha256({
    date: args.date,
    timeZone: args.timeZone,
    privacyMode: args.privacyMode,
    htmlSha256,
    textSha256,
  });
  return {
    version: 1,
    date: args.date,
    timeZone: args.timeZone,
    privacyMode: args.privacyMode,
    html,
    text,
    htmlSha256,
    textSha256,
    envelopeSha256,
  };
}

export function calendarCardApprovalPayload(args: {
  recipient: string;
  recipientEntityId: string;
  cardId: string;
  composition: CalendarCardComposition;
}): Extract<ApprovalPayload, { action: "send_message" }> {
  return {
    action: "send_message",
    recipient: args.recipient,
    body: args.composition.text,
    replyToMessageId: null,
    calendarCard: {
      kind: "calendar_card",
      version: 1,
      cardId: args.cardId,
      recipientEntityId: args.recipientEntityId,
      date: args.composition.date,
      timeZone: args.composition.timeZone,
      privacyMode: args.composition.privacyMode,
      textSha256: args.composition.textSha256,
      htmlSha256: args.composition.htmlSha256,
      envelopeSha256: args.composition.envelopeSha256,
    },
  };
}

export function verifyCalendarCardApproval(payload: ApprovalPayload): {
  correlation: CalendarCardApprovalCorrelation;
  actualTextSha256: string;
  matches: boolean;
} | null {
  if (payload.action !== "send_message" || !payload.calendarCard) return null;
  const actualTextSha256 = sha256(Buffer.from(payload.body, "utf8"));
  const actualEnvelopeSha256 = cardEnvelopeSha256({
    date: payload.calendarCard.date,
    timeZone: payload.calendarCard.timeZone,
    privacyMode: payload.calendarCard.privacyMode,
    htmlSha256: payload.calendarCard.htmlSha256,
    textSha256: actualTextSha256,
  });
  return {
    correlation: payload.calendarCard,
    actualTextSha256,
    matches:
      actualTextSha256 === payload.calendarCard.textSha256 &&
      actualEnvelopeSha256 === payload.calendarCard.envelopeSha256,
  };
}

export class CalendarCardAccessStore {
  constructor(
    private readonly runtime: IAgentRuntime,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async ensureSchema(): Promise<void> {
    for (const statement of SCHEMA)
      await executeRawSql(this.runtime, statement);
  }

  private files(): IFileStorageService {
    const service = this.runtime.getService<IFileStorageService>(
      ServiceType.REMOTE_FILES,
    );
    if (!service)
      throw new Error("Canonical file storage service is unavailable");
    return service;
  }

  async issue(args: {
    recipientEntityId: string;
    html: string;
    ttlMs: number;
    baseUrl: string;
  }): Promise<{ cardId: string; accessUrl: string; htmlSha256: string }> {
    if (!Number.isSafeInteger(args.ttlMs) || args.ttlMs < 1)
      throw new Error("Invalid card TTL");
    await this.ensureSchema();
    const bytes = Buffer.from(args.html, "utf8");
    const stored = await this.files().storePrivate(bytes, "text/html");
    const token = randomBytes(32).toString("base64url");
    const cardId = randomUUID();
    const createdAt = this.now();
    const expiresAt = new Date(createdAt.getTime() + args.ttlMs);
    await executeRawSql(
      this.runtime,
      `INSERT INTO app_lifeops.life_calendar_card_access
       (agent_id, card_id, token_sha256, recipient_entity_id, private_file_name,
        html_sha256, expires_at, consumed_at, revoked_at, created_at)
       VALUES (${sqlQuote(this.runtime.agentId)}, ${sqlQuote(cardId)},
        ${sqlQuote(sha256(token))}, ${sqlQuote(args.recipientEntityId)},
        ${sqlQuote(stored.fileName)}, ${sqlQuote(stored.hash)},
        ${sqlQuote(expiresAt.toISOString())}, NULL, NULL,
        ${sqlQuote(createdAt.toISOString())})`,
    );
    const url = new URL(`/api/lifeops/calendar/cards/${cardId}`, args.baseUrl);
    url.searchParams.set("token", token);
    return { cardId, accessUrl: url.toString(), htmlSha256: stored.hash };
  }

  async consume(args: {
    cardId: string;
    token: string;
    principalEntityId: string;
  }): Promise<Buffer> {
    await this.ensureSchema();
    const rows = await executeRawSql(
      this.runtime,
      `UPDATE app_lifeops.life_calendar_card_access SET consumed_at = ${sqlQuote(this.now().toISOString())}
       WHERE agent_id = ${sqlQuote(this.runtime.agentId)}
         AND card_id = ${sqlQuote(args.cardId)}
         AND token_sha256 = ${sqlQuote(sha256(args.token))}
         AND recipient_entity_id = ${sqlQuote(args.principalEntityId)}
         AND consumed_at IS NULL AND revoked_at IS NULL
         AND expires_at > ${sqlQuote(this.now().toISOString())}
       RETURNING *`,
    );
    if (!rows[0]) await this.throwAccessFailure(args);
    const row = rows[0] as Record<string, unknown>;
    const fileName = toText(row.private_file_name);
    const bytes = await this.files().readPrivate(fileName);
    if (!bytes)
      throw new CalendarCardAccessError(
        "Card bytes are missing",
        "CARD_BYTES_MISSING",
        410,
      );
    const expected = toText(row.html_sha256);
    const actual = sha256(bytes);
    if (actual !== expected) {
      await this.files().deletePrivate(fileName);
      throw new CalendarCardAccessError(
        "Card bytes failed integrity verification",
        "CARD_BYTES_TAMPERED",
        410,
      );
    }
    await this.files().deletePrivate(fileName);
    return bytes;
  }

  async verifyApprovedBytes(
    correlation: CalendarCardApprovalCorrelation,
  ): Promise<void> {
    await this.ensureSchema();
    const rows = await executeRawSql(
      this.runtime,
      `SELECT * FROM app_lifeops.life_calendar_card_access
       WHERE agent_id = ${sqlQuote(this.runtime.agentId)}
         AND card_id = ${sqlQuote(correlation.cardId)}`,
    );
    const row = rows[0] as Record<string, unknown> | undefined;
    if (
      !row ||
      toText(row.recipient_entity_id) !== correlation.recipientEntityId ||
      row.revoked_at ||
      row.consumed_at ||
      Date.parse(toText(row.expires_at)) <= this.now().getTime()
    ) {
      throw new CalendarCardAccessError(
        "Approved calendar card capability is no longer usable",
        "CARD_ACCESS_EXPIRED",
        410,
      );
    }
    const fileName = toText(row.private_file_name);
    const bytes = await this.files().readPrivate(fileName);
    if (!bytes) {
      throw new CalendarCardAccessError(
        "Card bytes are missing",
        "CARD_BYTES_MISSING",
        410,
      );
    }
    const actual = sha256(bytes);
    if (
      actual !== correlation.htmlSha256 ||
      actual !== toText(row.html_sha256)
    ) {
      throw new CalendarCardAccessError(
        "Card bytes failed integrity verification",
        "CARD_BYTES_TAMPERED",
        410,
      );
    }
  }

  private async throwAccessFailure(args: {
    cardId: string;
    token: string;
    principalEntityId: string;
  }): Promise<never> {
    const rows = await executeRawSql(
      this.runtime,
      `SELECT * FROM app_lifeops.life_calendar_card_access
       WHERE agent_id = ${sqlQuote(this.runtime.agentId)} AND card_id = ${sqlQuote(args.cardId)}`,
    );
    const row = rows[0] as Record<string, unknown> | undefined;
    if (!row || !equalDigest(toText(row.token_sha256), sha256(args.token))) {
      throw new CalendarCardAccessError(
        "Invalid calendar card capability",
        "CARD_ACCESS_INVALID",
        404,
      );
    }
    if (toText(row.recipient_entity_id) !== args.principalEntityId) {
      throw new CalendarCardAccessError(
        "Calendar card belongs to another identity",
        "CARD_ACCESS_WRONG_IDENTITY",
        403,
      );
    }
    if (row.revoked_at)
      throw new CalendarCardAccessError(
        "Calendar card was revoked",
        "CARD_ACCESS_REVOKED",
        410,
      );
    if (row.consumed_at)
      throw new CalendarCardAccessError(
        "Calendar card was already viewed",
        "CARD_ACCESS_REPLAY",
        410,
      );
    throw new CalendarCardAccessError(
      "Calendar card expired",
      "CARD_ACCESS_EXPIRED",
      410,
    );
  }

  async revoke(cardId: string): Promise<boolean> {
    await this.ensureSchema();
    const rows = await executeRawSql(
      this.runtime,
      `UPDATE app_lifeops.life_calendar_card_access SET revoked_at = ${sqlQuote(this.now().toISOString())}
       WHERE agent_id = ${sqlQuote(this.runtime.agentId)} AND card_id = ${sqlQuote(cardId)}
         AND revoked_at IS NULL AND consumed_at IS NULL RETURNING private_file_name`,
    );
    if (!rows[0]) return false;
    await this.files().deletePrivate(
      toText((rows[0] as Record<string, unknown>).private_file_name),
    );
    return true;
  }

  async cleanup(): Promise<number> {
    await this.ensureSchema();
    const rows = await executeRawSql(
      this.runtime,
      `DELETE FROM app_lifeops.life_calendar_card_access
       WHERE agent_id = ${sqlQuote(this.runtime.agentId)}
         AND (expires_at <= ${sqlQuote(this.now().toISOString())} OR revoked_at IS NOT NULL OR consumed_at IS NOT NULL)
       RETURNING private_file_name`,
    );
    for (const row of rows) {
      await this.files().deletePrivate(
        toText((row as Record<string, unknown>).private_file_name),
      );
    }
    return rows.length;
  }
}
