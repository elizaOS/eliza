/**
 * Persists calendar feed selection as one versioned SQL row per exact source.
 *
 * The database composite key and conditional `UPDATE ... WHERE version =`
 * are the cross-runtime compare-and-swap boundary. The former cache record is
 * read only to seed a missing row, so deployed two-field preferences migrate
 * without remaining authoritative or reintroducing whole-record races.
 */

import { ElizaError, type IAgentRuntime } from "@elizaos/core";
import type {
  LifeOpsCalendarProvider,
  LifeOpsCalendarSourceKey,
  LifeOpsConnectorSide,
} from "@elizaos/shared";
import {
  executeRawSql,
  executeRawSqlTx,
  sqlBoolean,
  sqlInteger,
  sqlQuote,
  toNumber,
  toText,
  withCalendarTransaction,
} from "../internal/sql.js";

export interface CalendarFeedPreferences {
  calendarFeedIncludes: Record<string, boolean>;
  calendarFeedVersions: Record<string, number>;
  updatedAt: string | null;
}

export interface CalendarFeedPreferenceIdentifier
  extends LifeOpsCalendarSourceKey {
  /** Used only when no durable exact-source row exists yet. */
  initialIncluded?: boolean;
}

export interface CalendarFeedPreferenceSnapshot {
  key: LifeOpsCalendarSourceKey;
  included: boolean;
  version: number;
  updatedAt: string;
}

export interface CalendarFeedPreferenceWriteReceipt {
  key: LifeOpsCalendarSourceKey;
  included: boolean;
  previousVersion: number;
  currentVersion: number;
  changed: boolean;
  updatedAt: string;
}

const LEGACY_CALENDAR_FEED_PREFERENCES_CACHE_KEY = "calendar:feed-preferences";

const VALID_PROVIDERS = new Set<LifeOpsCalendarProvider>([
  "google",
  "microsoft",
  "apple_calendar",
  "ics",
]);
const VALID_SIDES = new Set<LifeOpsConnectorSide>(["owner", "agent"]);

function requiredIdentityText(value: unknown, field: string): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) {
    throw new ElizaError(`Calendar source ${field} is required.`, {
      code: "CALENDAR_SOURCE_IDENTITY_INCOMPLETE",
      context: { field },
      severity: "ephemeral",
    });
  }
  return normalized;
}

function normalizeIdentifier(
  identifier: CalendarFeedPreferenceIdentifier,
): CalendarFeedPreferenceIdentifier {
  const provider = requiredIdentityText(
    identifier.provider,
    "provider",
  ) as LifeOpsCalendarProvider;
  if (!VALID_PROVIDERS.has(provider)) {
    throw new ElizaError("Calendar source provider is invalid.", {
      code: "CALENDAR_SOURCE_PROVIDER_INVALID",
      context: { provider },
      severity: "ephemeral",
    });
  }
  const side = requiredIdentityText(
    identifier.side,
    "side",
  ) as LifeOpsConnectorSide;
  if (!VALID_SIDES.has(side)) {
    throw new ElizaError("Calendar source side is invalid.", {
      code: "CALENDAR_SOURCE_SIDE_INVALID",
      context: { side },
      severity: "ephemeral",
    });
  }
  const grantId = requiredIdentityText(identifier.grantId, "grantId");
  const connectorAccountId = requiredIdentityText(
    identifier.connectorAccountId,
    "connectorAccountId",
  );
  const calendarId = requiredIdentityText(identifier.calendarId, "calendarId");
  if (
    provider === "ics" &&
    (side !== "owner" ||
      grantId !== connectorAccountId ||
      grantId !== calendarId)
  ) {
    throw new ElizaError(
      "ICS source identity must use its source id for grant, account, and calendar.",
      {
        code: "CALENDAR_SOURCE_IDENTITY_INVALID",
        context: {
          provider,
          side,
          grantId,
          connectorAccountId,
          calendarId,
        },
        severity: "ephemeral",
      },
    );
  }
  return {
    provider,
    side,
    grantId,
    connectorAccountId,
    calendarId,
    ...(typeof identifier.initialIncluded === "boolean"
      ? { initialIncluded: identifier.initialIncluded }
      : {}),
  };
}

function sourceKey(
  identifier: CalendarFeedPreferenceIdentifier,
): LifeOpsCalendarSourceKey {
  return {
    provider: identifier.provider,
    side: identifier.side,
    grantId: identifier.grantId,
    connectorAccountId: identifier.connectorAccountId,
    calendarId: identifier.calendarId,
  };
}

/**
 * JSON array encoding is injective for strings and avoids delimiter aliases
 * such as (`grant=a:b`, `calendar=c`) vs (`grant=a`, `calendar=b:c`).
 */
export function calendarFeedPreferenceKey(
  identifier: LifeOpsCalendarSourceKey,
): string {
  const normalized = normalizeIdentifier(identifier);
  return JSON.stringify([
    "calendar-source-v2",
    normalized.provider,
    normalized.side,
    normalized.grantId,
    normalized.connectorAccountId,
    normalized.calendarId,
  ]);
}

function legacyCalendarFeedPreferenceKey(
  grantId: string,
  calendarId: string,
): string {
  return `${grantId}:${calendarId}`;
}

function identityWhere(
  agentId: string,
  identifier: LifeOpsCalendarSourceKey,
): string {
  return `agent_id = ${sqlQuote(agentId)}
    AND provider = ${sqlQuote(identifier.provider)}
    AND side = ${sqlQuote(identifier.side)}
    AND grant_id = ${sqlQuote(identifier.grantId)}
    AND connector_account_id = ${sqlQuote(identifier.connectorAccountId)}
    AND calendar_id = ${sqlQuote(identifier.calendarId)}`;
}

function requiredRowText(row: Record<string, unknown>, column: string): string {
  const value = toText(row[column]).trim();
  if (!value) {
    throw new ElizaError(`Calendar feed preference row is missing ${column}.`, {
      code: "CALENDAR_SOURCE_PREFERENCE_ROW_INVALID",
      context: { column },
      severity: "fatal",
    });
  }
  return value;
}

function requiredRowBoolean(
  row: Record<string, unknown>,
  column: string,
): boolean {
  const value = row[column];
  if (value === true || value === "true" || value === 1) return true;
  if (value === false || value === "false" || value === 0) return false;
  throw new ElizaError(
    `Calendar feed preference row has an invalid ${column}.`,
    {
      code: "CALENDAR_SOURCE_PREFERENCE_ROW_INVALID",
      context: { column, value },
      severity: "fatal",
    },
  );
}

function preferenceFromRow(
  row: Record<string, unknown>,
): CalendarFeedPreferenceSnapshot {
  const version = toNumber(row.version, Number.NaN);
  if (!Number.isSafeInteger(version) || version < 0) {
    throw new ElizaError(
      "Calendar feed preference row has an invalid version.",
      {
        code: "CALENDAR_SOURCE_PREFERENCE_ROW_INVALID",
        context: { version: row.version },
        severity: "fatal",
      },
    );
  }
  const provider = requiredRowText(row, "provider") as LifeOpsCalendarProvider;
  const side = requiredRowText(row, "side") as LifeOpsConnectorSide;
  if (!VALID_PROVIDERS.has(provider) || !VALID_SIDES.has(side)) {
    throw new ElizaError(
      "Calendar feed preference row has an invalid source namespace.",
      {
        code: "CALENDAR_SOURCE_PREFERENCE_ROW_INVALID",
        context: { provider, side },
        severity: "fatal",
      },
    );
  }
  return {
    key: {
      provider,
      side,
      grantId: requiredRowText(row, "grant_id"),
      connectorAccountId: requiredRowText(row, "connector_account_id"),
      calendarId: requiredRowText(row, "calendar_id"),
    },
    included: requiredRowBoolean(row, "included"),
    version,
    updatedAt: requiredRowText(row, "updated_at"),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function legacyBoolean(value: unknown, key: string): boolean | undefined {
  if (!isRecord(value)) return undefined;
  const candidate = value[key];
  return typeof candidate === "boolean" ? candidate : undefined;
}

function legacyVersion(value: unknown, key: string): number | undefined {
  if (!isRecord(value)) return undefined;
  const candidate = value[key];
  return typeof candidate === "number" &&
    Number.isSafeInteger(candidate) &&
    candidate >= 0
    ? candidate
    : undefined;
}

async function readLegacySeed(
  runtime: IAgentRuntime,
  identifier: CalendarFeedPreferenceIdentifier,
): Promise<{ included: boolean; version: number }> {
  const cached = await runtime.getCache<unknown>(
    LEGACY_CALENDAR_FEED_PREFERENCES_CACHE_KEY,
  );
  const legacyKey = legacyCalendarFeedPreferenceKey(
    identifier.grantId,
    identifier.calendarId,
  );
  const exactKey = calendarFeedPreferenceKey(identifier);
  const includes = isRecord(cached) ? cached.calendarFeedIncludes : null;
  const versions = isRecord(cached) ? cached.calendarFeedVersions : null;
  return {
    included:
      legacyBoolean(includes, exactKey) ??
      legacyBoolean(includes, legacyKey) ??
      identifier.initialIncluded ??
      true,
    version:
      legacyVersion(versions, exactKey) ??
      legacyVersion(versions, legacyKey) ??
      0,
  };
}

async function selectPreference(
  runtime: IAgentRuntime,
  identifier: LifeOpsCalendarSourceKey,
): Promise<CalendarFeedPreferenceSnapshot | null> {
  const rows = await executeRawSql(
    runtime,
    `SELECT provider, side, grant_id, connector_account_id, calendar_id,
            included, version, updated_at
       FROM app_calendar.life_calendar_feed_preferences
      WHERE ${identityWhere(String(runtime.agentId), identifier)}
      LIMIT 1`,
  );
  return rows[0] ? preferenceFromRow(rows[0]) : null;
}

async function ensurePreference(
  runtime: IAgentRuntime,
  rawIdentifier: CalendarFeedPreferenceIdentifier,
): Promise<CalendarFeedPreferenceSnapshot> {
  const identifier = normalizeIdentifier(rawIdentifier);
  const existing = await selectPreference(runtime, identifier);
  if (existing) return existing;

  const seed = await readLegacySeed(runtime, identifier);
  const now = new Date().toISOString();
  const rows = await executeRawSql(
    runtime,
    `INSERT INTO app_calendar.life_calendar_feed_preferences (
       agent_id, provider, side, grant_id, connector_account_id, calendar_id,
       included, version, updated_at
     ) VALUES (
       ${sqlQuote(String(runtime.agentId))},
       ${sqlQuote(identifier.provider)},
       ${sqlQuote(identifier.side)},
       ${sqlQuote(identifier.grantId)},
       ${sqlQuote(identifier.connectorAccountId)},
       ${sqlQuote(identifier.calendarId)},
       ${sqlBoolean(seed.included)},
       ${sqlInteger(seed.version)},
       ${sqlQuote(now)}
     )
     ON CONFLICT (
       agent_id, provider, side, grant_id, connector_account_id, calendar_id
     ) DO NOTHING
     RETURNING provider, side, grant_id, connector_account_id, calendar_id,
               included, version, updated_at`,
  );
  if (rows[0]) return preferenceFromRow(rows[0]);

  const concurrent = await selectPreference(runtime, identifier);
  if (concurrent) return concurrent;
  throw new ElizaError("Calendar feed preference could not be initialized.", {
    code: "CALENDAR_SOURCE_PREFERENCE_INIT_FAILED",
    context: { source: sourceKey(identifier) },
    severity: "fatal",
  });
}

function normalizeIdentifiers(
  identifiers: readonly CalendarFeedPreferenceIdentifier[],
): CalendarFeedPreferenceIdentifier[] {
  const normalized = identifiers.map(normalizeIdentifier);
  const unique = new Map<string, CalendarFeedPreferenceIdentifier>();
  for (const identifier of normalized) {
    unique.set(calendarFeedPreferenceKey(identifier), identifier);
  }
  return [...unique.values()];
}

export async function ensureCalendarFeedIncludes(
  runtime: IAgentRuntime,
  identifiers: readonly CalendarFeedPreferenceIdentifier[],
): Promise<CalendarFeedPreferences> {
  const snapshots = await Promise.all(
    normalizeIdentifiers(identifiers).map((identifier) =>
      ensurePreference(runtime, identifier),
    ),
  );
  const calendarFeedIncludes: Record<string, boolean> = {};
  const calendarFeedVersions: Record<string, number> = {};
  let updatedAt: string | null = null;
  for (const snapshot of snapshots) {
    const key = calendarFeedPreferenceKey(snapshot.key);
    calendarFeedIncludes[key] = snapshot.included;
    calendarFeedVersions[key] = snapshot.version;
    if (!updatedAt || snapshot.updatedAt > updatedAt) {
      updatedAt = snapshot.updatedAt;
    }
  }
  return { calendarFeedIncludes, calendarFeedVersions, updatedAt };
}

export async function getCalendarFeedPreference(
  runtime: IAgentRuntime,
  identifier: CalendarFeedPreferenceIdentifier,
): Promise<CalendarFeedPreferenceSnapshot> {
  return ensurePreference(runtime, identifier);
}

function selectionConflict(
  identifier: LifeOpsCalendarSourceKey,
  expectedVersion: number,
  currentVersion: number | null,
): ElizaError {
  return new ElizaError(
    "Calendar source selection changed after it was listed. Refresh sources before retrying.",
    {
      code: "CALENDAR_SOURCE_SELECTION_CONFLICT",
      context: {
        source: identifier,
        expectedVersion,
        currentVersion,
      },
      severity: "ephemeral",
    },
  );
}

async function currentVersionAfterConflict(
  runtime: IAgentRuntime,
  identifier: LifeOpsCalendarSourceKey,
): Promise<number | null> {
  return (await selectPreference(runtime, identifier))?.version ?? null;
}

async function updatePreferenceCas(
  runtime: IAgentRuntime,
  identifier: LifeOpsCalendarSourceKey,
  included: boolean,
  expectedVersion: number,
): Promise<CalendarFeedPreferenceSnapshot> {
  const now = new Date().toISOString();
  const rows = await executeRawSql(
    runtime,
    `UPDATE app_calendar.life_calendar_feed_preferences
        SET included = ${sqlBoolean(included)},
            version = version + 1,
            updated_at = ${sqlQuote(now)}
      WHERE ${identityWhere(String(runtime.agentId), identifier)}
        AND version = ${sqlInteger(expectedVersion)}
    RETURNING provider, side, grant_id, connector_account_id, calendar_id,
              included, version, updated_at`,
  );
  if (rows[0]) return preferenceFromRow(rows[0]);
  throw selectionConflict(
    identifier,
    expectedVersion,
    await currentVersionAfterConflict(runtime, identifier),
  );
}

async function updateIcsPreferenceCas(
  runtime: IAgentRuntime,
  identifier: LifeOpsCalendarSourceKey,
  included: boolean,
  expectedVersion: number,
): Promise<CalendarFeedPreferenceSnapshot> {
  try {
    return await withCalendarTransaction(runtime, async (tx) => {
      const now = new Date().toISOString();
      const preferenceRows = await executeRawSqlTx(
        tx,
        `UPDATE app_calendar.life_calendar_feed_preferences
            SET included = ${sqlBoolean(included)},
                version = version + 1,
                updated_at = ${sqlQuote(now)}
          WHERE ${identityWhere(String(runtime.agentId), identifier)}
            AND version = ${sqlInteger(expectedVersion)}
        RETURNING provider, side, grant_id, connector_account_id, calendar_id,
                  included, version, updated_at`,
      );
      if (!preferenceRows[0]) {
        throw selectionConflict(identifier, expectedVersion, null);
      }
      const sourceRows = await executeRawSqlTx(
        tx,
        `UPDATE app_calendar.life_calendar_sources
            SET enabled = ${sqlBoolean(included)},
                updated_at = ${sqlQuote(now)}
          WHERE agent_id = ${sqlQuote(String(runtime.agentId))}
            AND provider = 'ics'
            AND side = ${sqlQuote(identifier.side)}
            AND id = ${sqlQuote(identifier.grantId)}
        RETURNING id`,
      );
      if (!sourceRows[0]) {
        throw new ElizaError(
          "The ICS source disappeared before selection could commit.",
          {
            code: "CALENDAR_ICS_SOURCE_NOT_FOUND",
            context: { source: identifier },
            severity: "ephemeral",
          },
        );
      }
      return preferenceFromRow(preferenceRows[0]);
    });
  } catch (cause) {
    if (
      cause instanceof ElizaError &&
      (cause.code === "CALENDAR_SOURCE_SELECTION_CONFLICT" ||
        cause.code === "CALENDAR_ICS_SOURCE_NOT_FOUND" ||
        cause.code === "CALENDAR_SOURCE_TRANSACTION_REQUIRED")
    ) {
      throw cause;
    }
    // error-policy:J2 The transaction guarantees both rows rolled back; expose
    // that consistency state so callers can safely refresh and retry.
    throw new ElizaError(
      "Calendar source selection was not changed because atomic persistence failed. Refresh and retry.",
      {
        code: "CALENDAR_SOURCE_ATOMIC_COMMIT_FAILED",
        cause,
        context: {
          source: identifier,
          expectedVersion,
          consistency: "rolled_back",
          retryable: true,
        },
        severity: "ephemeral",
      },
    );
  }
}

export async function setCalendarFeedIncluded(
  runtime: IAgentRuntime,
  rawIdentifier: CalendarFeedPreferenceIdentifier,
  included: boolean,
  expectedVersion: number,
): Promise<CalendarFeedPreferenceWriteReceipt> {
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) {
    throw new ElizaError(
      "Calendar source expectedVersion must be a non-negative safe integer.",
      {
        code: "CALENDAR_SOURCE_VERSION_INVALID",
        context: { expectedVersion },
        severity: "ephemeral",
      },
    );
  }
  const identifier = normalizeIdentifier(rawIdentifier);
  const before = await ensurePreference(runtime, identifier);
  if (before.version !== expectedVersion) {
    throw selectionConflict(
      sourceKey(identifier),
      expectedVersion,
      before.version,
    );
  }
  if (before.included === included) {
    return {
      key: sourceKey(identifier),
      included,
      previousVersion: expectedVersion,
      currentVersion: expectedVersion,
      changed: false,
      updatedAt: new Date().toISOString(),
    };
  }
  const key = sourceKey(identifier);
  const after =
    key.provider === "ics"
      ? await updateIcsPreferenceCas(runtime, key, included, expectedVersion)
      : await updatePreferenceCas(runtime, key, included, expectedVersion);
  return {
    key,
    included: after.included,
    previousVersion: expectedVersion,
    currentVersion: after.version,
    changed: before.included !== after.included,
    updatedAt: after.updatedAt,
  };
}
