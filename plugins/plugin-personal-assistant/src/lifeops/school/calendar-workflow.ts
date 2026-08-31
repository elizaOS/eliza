/**
 * Restart-safe school-calendar ingestion from a stable district landing page.
 * Discovery and PDF retrieval are DNS-pinned and bounded; canonical bytes are
 * retained through the runtime file store, semantic changes become an immutable
 * approval plan, and only the existing owner calendar mutation gateway applies
 * approved operations.
 */

import { createHash, randomUUID } from "node:crypto";
import {
  fetchRemoteMedia,
  fetchWithSsrfGuard,
  type IAgentRuntime,
  type IFileStorageService,
  type LookupFn,
  type PinnedLookupFetchLike,
  readResponseWithLimit,
  type Service,
  ServiceType,
} from "@elizaos/core";
import { ELIZA_CALENDAR_GRANT_ID } from "@elizaos/plugin-calendar/internal/eliza-calendar";
import type { CalendarOwnerMutationGateway } from "@elizaos/plugin-calendar/routes/mutation-gateway";
import type { LifeOpsCalendarEvent } from "@elizaos/shared";
import {
  executeRawSql,
  parseJsonArray,
  parseJsonRecord,
  sqlQuote,
  toText,
} from "../sql.js";

export const CONCORD_SCHOOL_CALENDAR_SOURCE: SchoolCalendarSourceConfig = {
  sourceId: "concord-cps-school-year-calendar",
  landingPageUrl:
    "https://www.concordps.org/district-resources/school-year-calendars",
  allowedHosts: ["www.concordps.org", "resources.finalsite.net"],
  pdfHrefPattern: "CPSCCRSD.*SchoolCalendar\\.pdf(?:$|[?#])",
  timeZone: "America/New_York",
  targetGrantId: ELIZA_CALENDAR_GRANT_ID,
  targetCalendarId: "primary",
};

export const SCHOOL_CALENDAR_MONTHLY_CRON = {
  kind: "cron",
  expression: "0 9 1 * *",
  tz: "America/New_York",
} as const;

const MAX_LANDING_BYTES = 512 * 1024;
const MAX_PDF_BYTES = 20 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 10_000;
const LEASE_MS = 5 * 60_000;

const SCHEMA = [
  `CREATE SCHEMA IF NOT EXISTS app_lifeops`,
  `CREATE TABLE IF NOT EXISTS app_lifeops.life_school_calendar_sources (
    agent_id TEXT NOT NULL, source_id TEXT NOT NULL, config_json TEXT NOT NULL,
    last_content_sha256 TEXT, last_media_url TEXT, lease_token TEXT,
    lease_expires_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    PRIMARY KEY (agent_id, source_id)
  )`,
  `CREATE TABLE IF NOT EXISTS app_lifeops.life_school_calendar_runs (
    agent_id TEXT NOT NULL, run_id TEXT NOT NULL, source_id TEXT NOT NULL,
    state TEXT NOT NULL, trigger_kind TEXT NOT NULL, discovered_pdf_url TEXT,
    content_sha256 TEXT, media_url TEXT, semantic_sha256 TEXT, plan_json TEXT,
    error_code TEXT, error_message TEXT, created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL, PRIMARY KEY (agent_id, run_id)
  )`,
  `CREATE INDEX IF NOT EXISTS life_school_calendar_runs_source_idx
    ON app_lifeops.life_school_calendar_runs (agent_id, source_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS app_lifeops.life_school_calendar_events (
    agent_id TEXT NOT NULL, source_id TEXT NOT NULL, event_key TEXT NOT NULL,
    semantic_json TEXT NOT NULL, provider_event_id TEXT,
    provider_version TEXT, active BOOLEAN NOT NULL DEFAULT TRUE,
    updated_at TEXT NOT NULL, PRIMARY KEY (agent_id, source_id, event_key)
  )`,
] as const;

export interface SchoolCalendarSourceConfig {
  sourceId: string;
  landingPageUrl: string;
  allowedHosts: string[];
  pdfHrefPattern: string;
  timeZone: string;
  targetGrantId: string;
  targetCalendarId: string;
}

export interface SchoolCalendarSemanticEvent {
  eventKey: string;
  title: string;
  startDate: string;
  endDateExclusive: string;
}

export type SchoolCalendarChange =
  | { kind: "add"; event: SchoolCalendarSemanticEvent }
  | {
      kind: "update";
      before: SchoolCalendarSemanticEvent;
      event: SchoolCalendarSemanticEvent;
      providerEventId: string;
      providerVersion: string;
    }
  | {
      kind: "cancel";
      event: SchoolCalendarSemanticEvent;
      providerEventId: string;
      providerVersion: string;
    }
  | { kind: "unchanged"; event: SchoolCalendarSemanticEvent };

export interface SchoolCalendarApprovalPlan {
  version: 1;
  sourceId: string;
  runId: string;
  contentSha256: string;
  mediaUrl: string;
  changes: SchoolCalendarChange[];
}

export type SchoolCalendarRunResult =
  | {
      state: "unchanged";
      runId: string;
      contentSha256: string;
      mediaUrl: string;
    }
  | {
      state: "awaiting_approval";
      runId: string;
      plan: SchoolCalendarApprovalPlan;
    }
  | { state: "already_running"; runId: null };

type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface SchoolCalendarWorkflowDeps {
  fetchImpl?: FetchLike;
  lookupFn?: LookupFn;
  pinnedFetchImpl?: PinnedLookupFetchLike;
  extractPdfText?: (bytes: Buffer) => Promise<string>;
  retainPdf?: (bytes: Buffer) => Promise<{ url: string; hash: string }>;
  now?: () => Date;
}

interface PersistedEvent extends SchoolCalendarSemanticEvent {
  providerEventId: string | null;
  providerVersion: string | null;
  active: boolean;
}

export class SchoolCalendarWorkflowError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "SchoolCalendarWorkflowError";
  }
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function assertAllowedUrl(
  value: string,
  config: SchoolCalendarSourceConfig,
): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new SchoolCalendarWorkflowError(
      `School calendar URL is invalid: ${error instanceof Error ? error.message : String(error)}`,
      "SCHOOL_CALENDAR_URL_INVALID",
    );
  }
  if (
    url.protocol !== "https:" ||
    !config.allowedHosts.includes(url.hostname.toLowerCase())
  ) {
    throw new SchoolCalendarWorkflowError(
      "School calendar URL is outside the configured HTTPS host allowlist.",
      "SCHOOL_CALENDAR_URL_NOT_ALLOWED",
    );
  }
  if (url.username || url.password) {
    throw new SchoolCalendarWorkflowError(
      "School calendar URLs cannot contain credentials.",
      "SCHOOL_CALENDAR_URL_NOT_ALLOWED",
    );
  }
  return url;
}

export function discoverSchoolCalendarPdf(
  html: string,
  finalLandingUrl: string,
  config: SchoolCalendarSourceConfig,
): string {
  const pattern = new RegExp(config.pdfHrefPattern, "i");
  const candidates = [...html.matchAll(/<a\b[^>]*>/giu)]
    .map((match) => match[0])
    .flatMap((anchor) => {
      const href = /\bhref\s*=\s*["']([^"']+)["']/iu.exec(anchor)?.[1];
      const fileName = /\bdata-file-name\s*=\s*["']([^"']+)["']/iu.exec(
        anchor,
      )?.[1];
      if (!href || (!pattern.test(href) && !pattern.test(fileName ?? ""))) {
        return [];
      }
      return [
        assertAllowedUrl(
          new URL(href, finalLandingUrl).toString(),
          config,
        ).toString(),
      ];
    });
  const unique = [...new Set(candidates)];
  if (unique.length !== 1) {
    throw new SchoolCalendarWorkflowError(
      `School calendar landing page resolved ${unique.length} matching PDFs; exactly one is required.`,
      "SCHOOL_CALENDAR_DISCOVERY_AMBIGUOUS",
    );
  }
  return unique[0];
}

function nextDate(date: string): string {
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime())) {
    throw new SchoolCalendarWorkflowError(
      "School calendar date is invalid.",
      "SCHOOL_CALENDAR_PARSE_INVALID",
    );
  }
  parsed.setUTCDate(parsed.getUTCDate() + 1);
  return parsed.toISOString().slice(0, 10);
}

export function parseSchoolCalendarText(
  text: string,
): SchoolCalendarSemanticEvent[] {
  const events: SchoolCalendarSemanticEvent[] = [];
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.replace(/\s+/gu, " ").trim();
    if (!line) continue;
    const match =
      /^(?:(\d{4}-\d{2}-\d{2})\s*[|–—-]\s*(.+)|(.+?)\s*[|–—-]\s*(\d{4}-\d{2}-\d{2}))$/u.exec(
        line,
      );
    if (!match) continue;
    const startDate = match[1] ?? match[4];
    const title = (match[2] ?? match[3] ?? "").trim();
    if (!startDate || !title) continue;
    events.push({
      eventKey: `school-date:${startDate}`,
      title,
      startDate,
      endDateExclusive: nextDate(startDate),
    });
  }
  if (events.length === 0) {
    throw new SchoolCalendarWorkflowError(
      "School calendar PDF did not contain any recognized dated entries.",
      "SCHOOL_CALENDAR_PARSE_EMPTY",
    );
  }
  const keys = new Set<string>();
  for (const event of events) {
    if (keys.has(event.eventKey)) {
      throw new SchoolCalendarWorkflowError(
        `School calendar contains more than one event for ${event.startDate}; owner review is required.`,
        "SCHOOL_CALENDAR_PARSE_AMBIGUOUS",
      );
    }
    keys.add(event.eventKey);
  }
  return events.sort((left, right) =>
    left.eventKey.localeCompare(right.eventKey),
  );
}

export function diffSchoolCalendarEvents(
  previous: readonly PersistedEvent[],
  current: readonly SchoolCalendarSemanticEvent[],
): SchoolCalendarChange[] {
  const oldByKey = new Map(
    previous
      .filter((event) => event.active)
      .map((event) => [event.eventKey, event]),
  );
  const newByKey = new Map(current.map((event) => [event.eventKey, event]));
  const keys = [...new Set([...oldByKey.keys(), ...newByKey.keys()])].sort();
  return keys.map((key) => {
    const before = oldByKey.get(key);
    const event = newByKey.get(key);
    if (!before && event) return { kind: "add", event };
    if (before && !event) {
      if (!before.providerEventId || !before.providerVersion) {
        throw new SchoolCalendarWorkflowError(
          `Cannot cancel ${key} without its provider identity and version.`,
          "SCHOOL_CALENDAR_PROVIDER_IDENTITY_MISSING",
        );
      }
      return {
        kind: "cancel",
        event: before,
        providerEventId: before.providerEventId,
        providerVersion: before.providerVersion,
      };
    }
    if (!before || !event)
      throw new Error("School calendar diff invariant failed");
    if (
      canonicalJson(before) ===
      canonicalJson({
        ...event,
        providerEventId: before.providerEventId,
        providerVersion: before.providerVersion,
        active: before.active,
      })
    ) {
      return { kind: "unchanged", event };
    }
    if (!before.providerEventId || !before.providerVersion) {
      throw new SchoolCalendarWorkflowError(
        `Cannot update ${key} without its provider identity and version.`,
        "SCHOOL_CALENDAR_PROVIDER_IDENTITY_MISSING",
      );
    }
    return {
      kind: "update",
      before,
      event,
      providerEventId: before.providerEventId,
      providerVersion: before.providerVersion,
    };
  });
}

export class SchoolCalendarWorkflow {
  private readonly now: () => Date;

  constructor(
    private readonly runtime: IAgentRuntime,
    private readonly deps: SchoolCalendarWorkflowDeps = {},
  ) {
    this.now = deps.now ?? (() => new Date());
  }

  async ensureSchema(): Promise<void> {
    for (const statement of SCHEMA)
      await executeRawSql(this.runtime, statement);
  }

  async run(
    config: SchoolCalendarSourceConfig = CONCORD_SCHOOL_CALENDAR_SOURCE,
    triggerKind: "manual" | "scheduled" = "manual",
  ): Promise<SchoolCalendarRunResult> {
    await this.ensureSchema();
    assertAllowedUrl(config.landingPageUrl, config);
    const leaseToken = randomUUID();
    const now = this.now();
    const acquired = await this.acquire(config, leaseToken, now);
    if (!acquired) return { state: "already_running", runId: null };
    const runId = randomUUID();
    await this.insertRun(runId, config.sourceId, triggerKind, now);
    try {
      const { pdfUrl, bytes } = await this.retrieve(config);
      const contentSha256 = sha256(bytes);
      const retained = await this.retain(bytes);
      if (retained.hash !== contentSha256) {
        throw new SchoolCalendarWorkflowError(
          "Canonical media store returned a mismatched content hash.",
          "SCHOOL_CALENDAR_MEDIA_HASH_MISMATCH",
        );
      }
      const source = await this.source(config.sourceId);
      if (source.lastContentSha256 === contentSha256) {
        await this.completeNoop(
          runId,
          config.sourceId,
          pdfUrl,
          contentSha256,
          retained.url,
          leaseToken,
        );
        return {
          state: "unchanged",
          runId,
          contentSha256,
          mediaUrl: retained.url,
        };
      }
      const text = await this.extract(bytes);
      const current = parseSchoolCalendarText(text);
      const previous = await this.events(config.sourceId);
      const changes = diffSchoolCalendarEvents(previous, current);
      if (changes.every((change) => change.kind === "unchanged")) {
        await this.completeNoop(
          runId,
          config.sourceId,
          pdfUrl,
          contentSha256,
          retained.url,
          leaseToken,
        );
        return {
          state: "unchanged",
          runId,
          contentSha256,
          mediaUrl: retained.url,
        };
      }
      const plan: SchoolCalendarApprovalPlan = {
        version: 1,
        sourceId: config.sourceId,
        runId,
        contentSha256,
        mediaUrl: retained.url,
        changes,
      };
      await this.awaitApproval(
        runId,
        config.sourceId,
        pdfUrl,
        plan,
        leaseToken,
      );
      return { state: "awaiting_approval", runId, plan };
    } catch (error) {
      await this.failRun(runId, config.sourceId, leaseToken, error);
      throw error;
    }
  }

  async applyApprovedPlan(args: {
    runId: string;
    requestUrl: URL;
    gateway: CalendarOwnerMutationGateway;
    config?: SchoolCalendarSourceConfig;
  }): Promise<void> {
    const config = args.config ?? CONCORD_SCHOOL_CALENDAR_SOURCE;
    const rows = await executeRawSql(
      this.runtime,
      `SELECT * FROM app_lifeops.life_school_calendar_runs WHERE agent_id = ${sqlQuote(this.runtime.agentId)} AND run_id = ${sqlQuote(args.runId)} LIMIT 1`,
    );
    const row = rows[0];
    if (!row || toText(row.state) !== "awaiting_approval") {
      throw new SchoolCalendarWorkflowError(
        "School calendar run is not awaiting approval.",
        "SCHOOL_CALENDAR_RUN_NOT_APPLICABLE",
      );
    }
    const plan = parseApprovalPlan(parseJsonRecord(row.plan_json));
    for (const change of plan.changes) {
      if (change.kind === "unchanged") continue;
      if (change.kind === "add") {
        const result = await args.gateway.create(args.requestUrl, {
          grantId: config.targetGrantId,
          calendarId: config.targetCalendarId,
          title: change.event.title,
          startAt: `${change.event.startDate}T00:00:00`,
          endAt: `${change.event.endDateExclusive}T00:00:00`,
          timeZone: config.timeZone,
          notifyAttendees: false,
          idempotencyKey: `${config.sourceId}:${change.event.eventKey}:${plan.contentSha256}`,
        });
        if (result.outcome !== "event" || !result.event) {
          throw new SchoolCalendarWorkflowError(
            "School event create did not return a readable event.",
            "SCHOOL_CALENDAR_CREATE_READBACK_REQUIRED",
          );
        }
        await this.upsertEvent(config.sourceId, change.event, result.event);
      } else if (change.kind === "update") {
        const event = await args.gateway.update(args.requestUrl, {
          grantId: config.targetGrantId,
          calendarId: config.targetCalendarId,
          eventId: change.providerEventId,
          title: change.event.title,
          startAt: `${change.event.startDate}T00:00:00`,
          endAt: `${change.event.endDateExclusive}T00:00:00`,
          timeZone: config.timeZone,
          expectedProviderVersion: change.providerVersion,
          idempotencyKey: `${config.sourceId}:${change.event.eventKey}:${plan.contentSha256}`,
        });
        await this.upsertEvent(config.sourceId, change.event, event);
      } else {
        await args.gateway.cancel(args.requestUrl, {
          grantId: config.targetGrantId,
          calendarId: config.targetCalendarId,
          eventId: change.providerEventId,
          notifyAttendees: false,
          expectedProviderVersion: change.providerVersion,
          cancellationMode: "organizer_cancel",
          idempotencyKey: `${config.sourceId}:${change.event.eventKey}:${plan.contentSha256}`,
        });
        await executeRawSql(
          this.runtime,
          `UPDATE app_lifeops.life_school_calendar_events SET active = FALSE, updated_at = ${sqlQuote(this.now().toISOString())} WHERE agent_id = ${sqlQuote(this.runtime.agentId)} AND source_id = ${sqlQuote(config.sourceId)} AND event_key = ${sqlQuote(change.event.eventKey)}`,
        );
      }
    }
    const at = this.now().toISOString();
    await executeRawSql(
      this.runtime,
      `UPDATE app_lifeops.life_school_calendar_runs SET state = 'applied', updated_at = ${sqlQuote(at)} WHERE agent_id = ${sqlQuote(this.runtime.agentId)} AND run_id = ${sqlQuote(args.runId)} AND state = 'awaiting_approval'`,
    );
    await executeRawSql(
      this.runtime,
      `UPDATE app_lifeops.life_school_calendar_sources SET last_content_sha256 = ${sqlQuote(plan.contentSha256)}, last_media_url = ${sqlQuote(plan.mediaUrl)}, updated_at = ${sqlQuote(at)} WHERE agent_id = ${sqlQuote(this.runtime.agentId)} AND source_id = ${sqlQuote(config.sourceId)}`,
    );
  }

  private async retrieve(
    config: SchoolCalendarSourceConfig,
  ): Promise<{ pdfUrl: string; bytes: Buffer }> {
    const guarded = await fetchWithSsrfGuard({
      url: config.landingPageUrl,
      fetchImpl: this.deps.fetchImpl,
      lookupFn: this.deps.lookupFn,
      pinnedFetchImpl: this.deps.pinnedFetchImpl,
      maxRedirects: 3,
      timeoutMs: FETCH_TIMEOUT_MS,
    });
    try {
      assertAllowedUrl(guarded.finalUrl, config);
      if (
        !guarded.response.ok ||
        !guarded.response.headers
          .get("content-type")
          ?.toLowerCase()
          .startsWith("text/html")
      ) {
        throw new SchoolCalendarWorkflowError(
          "School calendar landing page did not return HTML.",
          "SCHOOL_CALENDAR_LANDING_INVALID",
        );
      }
      const html = (
        await readResponseWithLimit(guarded.response, MAX_LANDING_BYTES)
      ).toString("utf8");
      const pdfUrl = discoverSchoolCalendarPdf(html, guarded.finalUrl, config);
      const pdf = await fetchRemoteMedia({
        url: pdfUrl,
        fetchImpl: this.deps.fetchImpl,
        lookupFn: this.deps.lookupFn,
        pinnedFetchImpl: this.deps.pinnedFetchImpl,
        maxBytes: MAX_PDF_BYTES,
        maxRedirects: 3,
        timeoutMs: FETCH_TIMEOUT_MS,
        requiredContentTypePrefix: "application/pdf",
        rejectContentEncoding: true,
      });
      if (!pdf.buffer.subarray(0, 5).equals(Buffer.from("%PDF-"))) {
        throw new SchoolCalendarWorkflowError(
          "School calendar response has no PDF signature.",
          "SCHOOL_CALENDAR_PDF_SIGNATURE_INVALID",
        );
      }
      return { pdfUrl, bytes: pdf.buffer };
    } finally {
      await guarded.release();
    }
  }

  private async retain(bytes: Buffer): Promise<{ url: string; hash: string }> {
    if (this.deps.retainPdf) return this.deps.retainPdf(bytes);
    const files = this.runtime.getService<IFileStorageService>(
      ServiceType.REMOTE_FILES,
    );
    if (!files)
      throw new SchoolCalendarWorkflowError(
        "Canonical file storage service is unavailable.",
        "SCHOOL_CALENDAR_FILE_STORE_UNAVAILABLE",
      );
    const stored = await files.store(bytes, "application/pdf");
    return { url: stored.url, hash: stored.hash };
  }

  private async extract(bytes: Buffer): Promise<string> {
    if (this.deps.extractPdfText) return this.deps.extractPdfText(bytes);
    const pdf = this.runtime.getService<
      Service & {
        convertPdfToText(input: Buffer): Promise<{ text: string }>;
      }
    >(ServiceType.PDF);
    if (!pdf)
      throw new SchoolCalendarWorkflowError(
        "PDF extraction service is unavailable.",
        "SCHOOL_CALENDAR_PDF_SERVICE_UNAVAILABLE",
      );
    return (await pdf.convertPdfToText(bytes)).text;
  }

  private async acquire(
    config: SchoolCalendarSourceConfig,
    token: string,
    now: Date,
  ): Promise<boolean> {
    const at = now.toISOString();
    const expires = new Date(now.getTime() + LEASE_MS).toISOString();
    await executeRawSql(
      this.runtime,
      `INSERT INTO app_lifeops.life_school_calendar_sources (agent_id, source_id, config_json, created_at, updated_at) VALUES (${sqlQuote(this.runtime.agentId)}, ${sqlQuote(config.sourceId)}, ${sqlQuote(canonicalJson(config))}, ${sqlQuote(at)}, ${sqlQuote(at)}) ON CONFLICT (agent_id, source_id) DO NOTHING`,
    );
    const rows = await executeRawSql(
      this.runtime,
      `UPDATE app_lifeops.life_school_calendar_sources SET lease_token = ${sqlQuote(token)}, lease_expires_at = ${sqlQuote(expires)}, config_json = ${sqlQuote(canonicalJson(config))}, updated_at = ${sqlQuote(at)} WHERE agent_id = ${sqlQuote(this.runtime.agentId)} AND source_id = ${sqlQuote(config.sourceId)} AND (lease_token IS NULL OR lease_expires_at < ${sqlQuote(at)}) RETURNING source_id`,
    );
    return rows.length === 1;
  }

  private async insertRun(
    runId: string,
    sourceId: string,
    triggerKind: string,
    now: Date,
  ): Promise<void> {
    const at = now.toISOString();
    await executeRawSql(
      this.runtime,
      `INSERT INTO app_lifeops.life_school_calendar_runs (agent_id, run_id, source_id, state, trigger_kind, created_at, updated_at) VALUES (${sqlQuote(this.runtime.agentId)}, ${sqlQuote(runId)}, ${sqlQuote(sourceId)}, 'running', ${sqlQuote(triggerKind)}, ${sqlQuote(at)}, ${sqlQuote(at)})`,
    );
  }

  private async source(
    sourceId: string,
  ): Promise<{ lastContentSha256: string | null }> {
    const rows = await executeRawSql(
      this.runtime,
      `SELECT last_content_sha256 FROM app_lifeops.life_school_calendar_sources WHERE agent_id = ${sqlQuote(this.runtime.agentId)} AND source_id = ${sqlQuote(sourceId)} LIMIT 1`,
    );
    return {
      lastContentSha256: rows[0]?.last_content_sha256
        ? toText(rows[0].last_content_sha256)
        : null,
    };
  }

  private async events(sourceId: string): Promise<PersistedEvent[]> {
    const rows = await executeRawSql(
      this.runtime,
      `SELECT * FROM app_lifeops.life_school_calendar_events WHERE agent_id = ${sqlQuote(this.runtime.agentId)} AND source_id = ${sqlQuote(sourceId)}`,
    );
    return rows.map((row) => ({
      ...(parseJsonRecord(
        row.semantic_json,
      ) as unknown as SchoolCalendarSemanticEvent),
      providerEventId: row.provider_event_id
        ? toText(row.provider_event_id)
        : null,
      providerVersion: row.provider_version
        ? toText(row.provider_version)
        : null,
      active: row.active === true || row.active === 1 || row.active === "true",
    }));
  }

  private async completeNoop(
    runId: string,
    sourceId: string,
    pdfUrl: string,
    hash: string,
    mediaUrl: string,
    lease: string,
  ): Promise<void> {
    const at = this.now().toISOString();
    await executeRawSql(
      this.runtime,
      `UPDATE app_lifeops.life_school_calendar_runs SET state = 'unchanged', discovered_pdf_url = ${sqlQuote(pdfUrl)}, content_sha256 = ${sqlQuote(hash)}, media_url = ${sqlQuote(mediaUrl)}, updated_at = ${sqlQuote(at)} WHERE agent_id = ${sqlQuote(this.runtime.agentId)} AND run_id = ${sqlQuote(runId)}`,
    );
    await executeRawSql(
      this.runtime,
      `UPDATE app_lifeops.life_school_calendar_sources SET last_content_sha256 = ${sqlQuote(hash)}, last_media_url = ${sqlQuote(mediaUrl)}, updated_at = ${sqlQuote(at)} WHERE agent_id = ${sqlQuote(this.runtime.agentId)} AND source_id = ${sqlQuote(sourceId)}`,
    );
    await this.release(sourceId, lease, at);
  }

  private async awaitApproval(
    runId: string,
    sourceId: string,
    pdfUrl: string,
    plan: SchoolCalendarApprovalPlan,
    lease: string,
  ): Promise<void> {
    const at = this.now().toISOString();
    const semanticSha = sha256(canonicalJson(plan.changes));
    await executeRawSql(
      this.runtime,
      `UPDATE app_lifeops.life_school_calendar_runs SET state = 'awaiting_approval', discovered_pdf_url = ${sqlQuote(pdfUrl)}, content_sha256 = ${sqlQuote(plan.contentSha256)}, media_url = ${sqlQuote(plan.mediaUrl)}, semantic_sha256 = ${sqlQuote(semanticSha)}, plan_json = ${sqlQuote(canonicalJson(plan))}, updated_at = ${sqlQuote(at)} WHERE agent_id = ${sqlQuote(this.runtime.agentId)} AND run_id = ${sqlQuote(runId)}`,
    );
    await this.release(sourceId, lease, at);
  }

  private async failRun(
    runId: string,
    sourceId: string,
    lease: string,
    error: unknown,
  ): Promise<void> {
    const at = this.now().toISOString();
    const code =
      error instanceof SchoolCalendarWorkflowError
        ? error.code
        : "SCHOOL_CALENDAR_RUN_FAILED";
    const message = error instanceof Error ? error.message : String(error);
    await executeRawSql(
      this.runtime,
      `UPDATE app_lifeops.life_school_calendar_runs SET state = 'failed', error_code = ${sqlQuote(code)}, error_message = ${sqlQuote(message)}, updated_at = ${sqlQuote(at)} WHERE agent_id = ${sqlQuote(this.runtime.agentId)} AND run_id = ${sqlQuote(runId)}`,
    );
    await this.release(sourceId, lease, at);
  }

  private async release(
    sourceId: string,
    lease: string,
    at: string,
  ): Promise<void> {
    await executeRawSql(
      this.runtime,
      `UPDATE app_lifeops.life_school_calendar_sources SET lease_token = NULL, lease_expires_at = NULL, updated_at = ${sqlQuote(at)} WHERE agent_id = ${sqlQuote(this.runtime.agentId)} AND source_id = ${sqlQuote(sourceId)} AND lease_token = ${sqlQuote(lease)}`,
    );
  }

  private async upsertEvent(
    sourceId: string,
    semantic: SchoolCalendarSemanticEvent,
    provider: LifeOpsCalendarEvent,
  ): Promise<void> {
    const version =
      typeof provider.metadata.etag === "string"
        ? provider.metadata.etag
        : null;
    if (!version)
      throw new SchoolCalendarWorkflowError(
        "Calendar provider omitted the event version.",
        "SCHOOL_CALENDAR_PROVIDER_VERSION_MISSING",
      );
    await executeRawSql(
      this.runtime,
      `INSERT INTO app_lifeops.life_school_calendar_events (agent_id, source_id, event_key, semantic_json, provider_event_id, provider_version, active, updated_at) VALUES (${sqlQuote(this.runtime.agentId)}, ${sqlQuote(sourceId)}, ${sqlQuote(semantic.eventKey)}, ${sqlQuote(canonicalJson(semantic))}, ${sqlQuote(provider.externalId)}, ${sqlQuote(version)}, TRUE, ${sqlQuote(this.now().toISOString())}) ON CONFLICT (agent_id, source_id, event_key) DO UPDATE SET semantic_json = EXCLUDED.semantic_json, provider_event_id = EXCLUDED.provider_event_id, provider_version = EXCLUDED.provider_version, active = TRUE, updated_at = EXCLUDED.updated_at`,
    );
  }
}

function parseApprovalPlan(
  value: Record<string, unknown>,
): SchoolCalendarApprovalPlan {
  if (
    value.version !== 1 ||
    typeof value.sourceId !== "string" ||
    typeof value.runId !== "string" ||
    typeof value.contentSha256 !== "string" ||
    typeof value.mediaUrl !== "string"
  ) {
    throw new SchoolCalendarWorkflowError(
      "Persisted school calendar approval plan is invalid.",
      "SCHOOL_CALENDAR_PLAN_INVALID",
    );
  }
  return {
    version: 1,
    sourceId: value.sourceId,
    runId: value.runId,
    contentSha256: value.contentSha256,
    mediaUrl: value.mediaUrl,
    changes: parseJsonArray(value.changes) as SchoolCalendarChange[],
  };
}
