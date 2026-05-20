import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import {
  db,
  generateSnowflakeId,
  type JsonValue,
  sentryWebhookInboxes,
} from '@feed/db';
import { logger } from '@feed/shared';

const DEFAULT_MAX_TIMESTAMP_SKEW_SECONDS = 300;
const HMAC_SHA256_HEX_LENGTH = 64;
const HEX_PATTERN = /^[a-f0-9]+$/i;

type JsonObject = Record<string, JsonValue>;

export interface SentryWebhookHeaders {
  signature: string | null;
  timestamp: string | null;
  resource: string | null;
  event: string | null;
  requestId: string | null;
  userAgent: string | null;
}

export interface IngestSentryWebhookInput {
  rawBody: string;
  headers: SentryWebhookHeaders;
  secret: string;
  maxTimestampSkewSeconds?: number;
  now?: Date;
}

type IngestSentryWebhookErrorCode =
  | 'MISSING_SIGNATURE'
  | 'MISSING_TIMESTAMP'
  | 'INVALID_SIGNATURE'
  | 'INVALID_TIMESTAMP'
  | 'STALE_TIMESTAMP'
  | 'INVALID_JSON'
  | 'INVALID_PAYLOAD_SHAPE';

export interface IngestSentryWebhookFailure {
  ok: false;
  httpStatus: 400 | 401;
  code: IngestSentryWebhookErrorCode;
  message: string;
}

export interface IngestSentryWebhookSuccess {
  ok: true;
  enqueued: boolean;
  inboxId?: string;
  dedupeKey: string;
  resource: string;
  action: string | null;
  projectSlug: string | null;
  issueId: string | null;
  eventId: string | null;
}

export type IngestSentryWebhookResult =
  | IngestSentryWebhookFailure
  | IngestSentryWebhookSuccess;

function trimToNull(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeSignature(signature: string): string {
  const trimmed = signature.trim();

  if (trimmed.startsWith('sha256=')) {
    return trimmed.slice('sha256='.length);
  }

  if (trimmed.startsWith('v0=')) {
    return trimmed.slice('v0='.length);
  }

  return trimmed;
}

function isValidHexDigest(value: string): boolean {
  return value.length === HMAC_SHA256_HEX_LENGTH && HEX_PATTERN.test(value);
}

function areHexDigestsEqual(leftHex: string, rightHex: string): boolean {
  const leftBuffer = Buffer.from(leftHex, 'hex');
  const rightBuffer = Buffer.from(rightHex, 'hex');

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return timingSafeEqual(leftBuffer, rightBuffer);
}

function computeTimestampPrefixedSentrySignature(
  secret: string,
  timestamp: string,
  rawBody: string
): string {
  return createHmac('sha256', secret)
    .update(`${timestamp}.${rawBody}`)
    .digest('hex');
}

function computeBodyOnlySentrySignature(
  secret: string,
  rawBody: string
): string {
  return createHmac('sha256', secret).update(rawBody).digest('hex');
}

function isSupportedSentrySignature(params: {
  secret: string;
  timestamp: string;
  rawBody: string;
  providedSignature: string;
}): boolean {
  const timestampPrefixedSignature = computeTimestampPrefixedSentrySignature(
    params.secret,
    params.timestamp,
    params.rawBody
  );
  if (
    areHexDigestsEqual(timestampPrefixedSignature, params.providedSignature)
  ) {
    return true;
  }

  const bodyOnlySignature = computeBodyOnlySentrySignature(
    params.secret,
    params.rawBody
  );
  return areHexDigestsEqual(bodyOnlySignature, params.providedSignature);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return true;
  }

  if (Array.isArray(value)) {
    return value.every((item) => isJsonValue(item));
  }

  if (typeof value === 'object') {
    return Object.values(value).every((item) => isJsonValue(item));
  }

  return false;
}

function isJsonObject(value: JsonValue): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readPath(
  source: JsonObject,
  path: readonly string[]
): JsonValue | undefined {
  let current: JsonValue = source;

  for (const segment of path) {
    if (!isJsonObject(current)) {
      return undefined;
    }
    const next: JsonValue | undefined = current[segment];
    if (typeof next === 'undefined') {
      return undefined;
    }
    current = next;
  }

  return current;
}

function toOptionalString(value: JsonValue | undefined): string | null {
  if (typeof value === 'string') {
    return trimToNull(value);
  }

  if (typeof value === 'number') {
    return String(value);
  }

  return null;
}

function getFirstString(
  source: JsonObject,
  candidatePaths: readonly (readonly string[])[]
): string | null {
  for (const path of candidatePaths) {
    const value = toOptionalString(readPath(source, path));
    if (value) {
      return value;
    }
  }

  return null;
}

function parseWebhookTimestamp(
  rawTimestamp: string,
  now: Date,
  maxSkewSeconds: number
): { ok: true; timestampSeconds: number } | IngestSentryWebhookFailure {
  const timestampSeconds = Number.parseInt(rawTimestamp, 10);
  if (!Number.isInteger(timestampSeconds) || timestampSeconds <= 0) {
    return {
      ok: false,
      httpStatus: 401,
      code: 'INVALID_TIMESTAMP',
      message: 'Invalid sentry-hook-timestamp header.',
    };
  }

  const nowSeconds = Math.floor(now.getTime() / 1000);
  if (Math.abs(nowSeconds - timestampSeconds) > maxSkewSeconds) {
    return {
      ok: false,
      httpStatus: 401,
      code: 'STALE_TIMESTAMP',
      message: 'Sentry webhook timestamp outside allowed window.',
    };
  }

  return { ok: true, timestampSeconds };
}

function buildDedupeKey(params: {
  resource: string;
  action: string | null;
  projectSlug: string | null;
  issueId: string | null;
  issueShortId: string | null;
  eventId: string | null;
  bodyHash: string;
}): string {
  const actionPart = params.action ?? 'unknown-action';
  const projectPart = params.projectSlug ?? 'unknown-project';
  const issuePart = params.issueId ?? params.issueShortId ?? 'unknown-issue';

  if (params.eventId) {
    return `sentry:${params.resource}:${actionPart}:${projectPart}:event:${params.eventId}`;
  }

  return `sentry:${params.resource}:${actionPart}:${projectPart}:issue:${issuePart}:body:${params.bodyHash}`;
}

function buildRoutingKey(params: {
  projectSlug: string | null;
  issueId: string | null;
  issueShortId: string | null;
  level: string | null;
  action: string | null;
}): string | null {
  const parts: string[] = [];

  if (params.projectSlug) {
    parts.push(`project:${params.projectSlug}`);
  }
  if (params.issueId ?? params.issueShortId) {
    parts.push(`issue:${params.issueId ?? params.issueShortId}`);
  }
  if (params.level) {
    parts.push(`level:${params.level}`);
  }
  if (params.action) {
    parts.push(`action:${params.action}`);
  }

  return parts.length > 0 ? parts.join('|') : null;
}

function toMetadata(params: {
  bodyHash: string;
  headers: SentryWebhookHeaders;
  receivedAt: Date;
}): JsonValue {
  return {
    headers: {
      sentryHookTimestamp: params.headers.timestamp,
      sentryHookResource: params.headers.resource,
      sentryHookEvent: params.headers.event,
      requestId: params.headers.requestId,
      userAgent: params.headers.userAgent,
    },
    ingestion: {
      bodyHash: params.bodyHash,
      receivedAt: params.receivedAt.toISOString(),
      signatureAlgorithm: 'hmac-sha256',
    },
  };
}

export async function ingestSentryWebhook(
  input: IngestSentryWebhookInput
): Promise<IngestSentryWebhookResult> {
  const signatureHeader = trimToNull(input.headers.signature);
  if (!signatureHeader) {
    return {
      ok: false,
      httpStatus: 401,
      code: 'MISSING_SIGNATURE',
      message: 'Missing sentry-hook-signature header.',
    };
  }

  const timestampHeader = trimToNull(input.headers.timestamp);
  if (!timestampHeader) {
    return {
      ok: false,
      httpStatus: 401,
      code: 'MISSING_TIMESTAMP',
      message: 'Missing sentry-hook-timestamp header.',
    };
  }

  const now = input.now ?? new Date();
  const maxSkewSeconds =
    input.maxTimestampSkewSeconds ?? DEFAULT_MAX_TIMESTAMP_SKEW_SECONDS;
  const parsedTimestamp = parseWebhookTimestamp(
    timestampHeader,
    now,
    maxSkewSeconds
  );
  if (!parsedTimestamp.ok) {
    return parsedTimestamp;
  }

  const providedSignature = normalizeSignature(signatureHeader);
  if (!isValidHexDigest(providedSignature)) {
    return {
      ok: false,
      httpStatus: 401,
      code: 'INVALID_SIGNATURE',
      message: 'Invalid sentry-hook-signature format.',
    };
  }

  if (
    !isSupportedSentrySignature({
      secret: input.secret,
      timestamp: timestampHeader,
      rawBody: input.rawBody,
      providedSignature,
    })
  ) {
    return {
      ok: false,
      httpStatus: 401,
      code: 'INVALID_SIGNATURE',
      message: 'Sentry webhook signature mismatch.',
    };
  }

  let parsedPayloadUnknown: unknown;
  try {
    parsedPayloadUnknown = JSON.parse(input.rawBody);
  } catch {
    return {
      ok: false,
      httpStatus: 400,
      code: 'INVALID_JSON',
      message: 'Webhook payload is not valid JSON.',
    };
  }

  if (!isJsonValue(parsedPayloadUnknown)) {
    return {
      ok: false,
      httpStatus: 400,
      code: 'INVALID_PAYLOAD_SHAPE',
      message: 'Webhook payload is not JSON-serializable.',
    };
  }

  const payload = parsedPayloadUnknown;
  if (!isJsonObject(payload)) {
    return {
      ok: false,
      httpStatus: 400,
      code: 'INVALID_PAYLOAD_SHAPE',
      message: 'Webhook payload must be a JSON object.',
    };
  }

  const action =
    getFirstString(payload, [['action'], ['data', 'action']]) ??
    trimToNull(input.headers.event);
  const resource =
    trimToNull(input.headers.resource) ??
    getFirstString(payload, [['resource'], ['data', 'resource']]) ??
    'issue';
  const projectSlug = getFirstString(payload, [
    ['data', 'project', 'slug'],
    ['project', 'slug'],
    ['project', 'name'],
    ['project'],
    ['project_slug'],
  ]);
  const organizationSlug = getFirstString(payload, [
    ['data', 'organization', 'slug'],
    ['organization', 'slug'],
    ['organization'],
    ['organization_slug'],
  ]);
  const issueId = getFirstString(payload, [
    ['data', 'issue', 'id'],
    ['issue', 'id'],
    ['data', 'group', 'id'],
    ['group', 'id'],
    ['group_id'],
  ]);
  const issueShortId = getFirstString(payload, [
    ['data', 'issue', 'shortId'],
    ['issue', 'shortId'],
    ['data', 'group', 'shortId'],
    ['group', 'shortId'],
    ['shortId'],
  ]);
  const issueTitle = getFirstString(payload, [
    ['data', 'issue', 'title'],
    ['issue', 'title'],
    ['data', 'group', 'title'],
    ['group', 'title'],
    ['title'],
  ]);
  const issueUrl = getFirstString(payload, [
    ['data', 'issue', 'permalink'],
    ['data', 'issue', 'url'],
    ['issue', 'permalink'],
    ['issue', 'url'],
    ['url'],
  ]);
  const eventId = getFirstString(payload, [
    ['data', 'event', 'id'],
    ['event', 'id'],
    ['data', 'event_id'],
    ['event_id'],
  ]);
  const level = getFirstString(payload, [
    ['data', 'event', 'level'],
    ['event', 'level'],
    ['level'],
  ]);
  const culprit = getFirstString(payload, [
    ['data', 'event', 'culprit'],
    ['event', 'culprit'],
    ['culprit'],
  ]);

  const bodyHash = createHash('sha256').update(input.rawBody).digest('hex');
  const dedupeKey = buildDedupeKey({
    resource,
    action,
    projectSlug,
    issueId,
    issueShortId,
    eventId,
    bodyHash,
  });
  const routingKey = buildRoutingKey({
    projectSlug,
    issueId,
    issueShortId,
    level,
    action,
  });
  const webhookTimestamp = new Date(parsedTimestamp.timestampSeconds * 1000);
  const inboxId = await generateSnowflakeId();
  const insertResult = await db
    .insert(sentryWebhookInboxes)
    .values({
      id: inboxId,
      resource,
      action,
      organizationSlug,
      projectSlug,
      issueId,
      issueShortId,
      issueTitle,
      issueUrl,
      eventId,
      level,
      culprit,
      dedupeKey,
      routingKey,
      webhookTimestamp,
      payload,
      metadata: toMetadata({
        bodyHash,
        headers: input.headers,
        receivedAt: now,
      }),
      receivedAt: now,
      nextAttemptAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({ target: sentryWebhookInboxes.dedupeKey })
    .returning({ id: sentryWebhookInboxes.id });

  const insertedId = insertResult[0]?.id;
  if (!insertedId) {
    logger.info(
      'Ignored duplicate Sentry webhook event',
      {
        dedupeKey,
        resource,
        action,
        projectSlug,
        issueId,
        eventId,
      },
      'SentryWebhookInbox'
    );

    return {
      ok: true,
      enqueued: false,
      dedupeKey,
      resource,
      action,
      projectSlug,
      issueId,
      eventId,
    };
  }

  logger.info(
    'Enqueued Sentry webhook event',
    {
      inboxId: insertedId,
      dedupeKey,
      resource,
      action,
      projectSlug,
      issueId,
      eventId,
    },
    'SentryWebhookInbox'
  );

  return {
    ok: true,
    enqueued: true,
    inboxId: insertedId,
    dedupeKey,
    resource,
    action,
    projectSlug,
    issueId,
    eventId,
  };
}
