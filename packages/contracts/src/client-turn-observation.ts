/**
 * Typed current-turn client observation, carried once per message as
 * `content.metadata.clientDevice.context`.
 *
 * A renderer reports which screen and optional Calendar day are visible and which record, if any, is
 * selected, using opaque identifiers only. The observation is untrusted data
 * for the message it accompanies: it carries no record contents, it is not an
 * instruction, and it grants no device access. A phone that holds the
 * platform location permission may also report its last known position, so
 * the agent knows where the phone is without asking. Device-action admission,
 * planner hints and prompt assembly read it through this one contract, so a
 * client does not wrap the user's authored text in its own instruction
 * envelope. Product hosts may apply narrower view and selection allowlists
 * before sending; this contract only fixes the shared shape and bounds.
 */

import { normalizeRemoteAgentPairingInstanceId } from "./contracts/remote-agent-pairing.ts";

/** Upper bound for the serialized observation, in UTF-8 bytes. */
export const CLIENT_TURN_OBSERVATION_MAX_BYTES = 2048;

export interface ClientSelectedObject {
  /** Registered selection kind, for example `canonical-note` or `reminder`. */
  readonly kind: string;
  /** Opaque record identifier; never a path, URL, display name or content. */
  readonly id: string;
  /** Opaque record revision or provider version (quoted ETags allowed). */
  readonly revision?: string;
  /** Opaque source identity: an account, calendar or notes source. */
  readonly accountId?: string;
  /** Revision of that source. */
  readonly sourceRevision?: string;
  /** Identity of one occurrence of a recurring record. */
  readonly occurrenceId?: string;
  /** Timing schema of the selected occurrence, when it is not the original. */
  readonly timingVersion?: 2;
}

/** The visible civil day is a lookup bound, never record or write authority. */
export interface ClientCalendarDayObservation {
  readonly date: string;
  readonly timeZone: string;
}

/**
 * The phone's last known position. The client sends it only while the
 * platform location permission is granted and the owner has location on.
 */
export interface ClientLocationObservation {
  readonly latitude: number;
  readonly longitude: number;
  /** Horizontal accuracy radius in meters, when the platform reports one. */
  readonly accuracyMeters?: number;
  /** When the platform took the fix, in epoch milliseconds. */
  readonly capturedAt: number;
}

/** Optional observation fields a peer may declare it reads. */
export type ClientTurnObservationOptionalField = "calendarDay" | "location";
const OPTIONAL_FIELDS: readonly ClientTurnObservationOptionalField[] = [
  "calendarDay",
  "location",
];

/** Data-format support, never a device or Calendar permission. */
export interface ClientTurnObservationSupport {
  readonly version: 1;
  readonly optionalFields: readonly ClientTurnObservationOptionalField[];
}
export const CLIENT_TURN_OBSERVATION_SUPPORT: ClientTurnObservationSupport =
  Object.freeze({
    version: 1,
    optionalFields: Object.freeze([...OPTIONAL_FIELDS]),
  });

export interface ClientTurnObservation {
  /** Visible view identifier reported by the renderer. */
  readonly view: string;
  /** Monotonic renderer revision of this observation. */
  readonly revision: number;
  /** A sensitive screen (credentials, unlock, vault) shares no selection. */
  readonly sensitive: boolean;
  /** IANA time zone of the device clock. */
  readonly timeZone?: string;
  readonly selectedObject?: ClientSelectedObject;
  readonly calendarDay?: ClientCalendarDayObservation;
  readonly location?: ClientLocationObservation;
}

const NAME = /^[a-z][a-z0-9-]{0,63}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@=+-]{0,511}$/;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:@=+-]{0,255}$/;
// Provider versions may be strong or weak HTTP entity tags.
// Bounded by REVISION_MAX_LENGTH like every other revision form.
const ENTITY_TAG = /^(?:W\/)?"[!#-~]+"$/;
const REVISION_MAX_LENGTH = 256;
const TIME_ZONE = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+){0,3}$/;
const OBSERVATION_KEYS = new Set([
  "view",
  "revision",
  "sensitive",
  "timeZone",
  "selectedObject",
  "calendarDay",
  "location",
]);
const LOCATION_KEYS = new Set([
  "latitude",
  "longitude",
  "accuracyMeters",
  "capturedAt",
]);
const CALENDAR_DAY_KEYS = new Set(["date", "timeZone"]);
const SUPPORT_KEYS = new Set(["version", "optionalFields"]);
const SELECTION_KEYS = new Set([
  "kind",
  "id",
  "revision",
  "accountId",
  "sourceRevision",
  "occurrenceId",
  "timingVersion",
]);

export class ClientTurnObservationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClientTurnObservationError";
  }
}

function plainRecord(value: unknown, what: string): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  )
    throw new ClientTurnObservationError(`${what} must be a plain object`);
  return value as Record<string, unknown>;
}

function onlyKeys(
  record: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  what: string,
): void {
  for (const key of Object.keys(record))
    if (!allowed.has(key))
      throw new ClientTurnObservationError(`${what} has unsupported field`);
}

function matching(value: unknown, pattern: RegExp, what: string): string {
  if (typeof value !== "string" || !pattern.test(value))
    throw new ClientTurnObservationError(`${what} is invalid`);
  return value;
}

function optionalToken(value: unknown, what: string): string | undefined {
  return value === undefined ? undefined : matching(value, TOKEN, what);
}

/** Validates an IANA zone name with the platform's time-zone database. */
export function isClientTimeZone(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 64 || !TIME_ZONE.test(value))
    return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** Missing or malformed peer declarations keep optional fields disabled. */
export function readClientTurnObservationSupport(
  value: unknown,
): ClientTurnObservationSupport | undefined {
  try {
    const input = plainRecord(value, "Client observation support");
    onlyKeys(input, SUPPORT_KEYS, "Client observation support");
    const fields = input.optionalFields;
    if (
      input.version !== 1 ||
      !Array.isArray(fields) ||
      fields.length > OPTIONAL_FIELDS.length ||
      new Set(fields).size !== fields.length ||
      !fields.every((field) =>
        OPTIONAL_FIELDS.includes(field as ClientTurnObservationOptionalField),
      )
    )
      return;
    // Canonical order, so equal declarations compare equal.
    return Object.freeze({
      version: 1,
      optionalFields: Object.freeze(
        OPTIONAL_FIELDS.filter((field) => fields.includes(field)),
      ),
    });
  } catch {
    return;
  }
}

/** Match a current authenticated handshake's known API process, never infer one. */
export function readClientTurnObservationPeerSupport(
  status: unknown,
  expectedServerInstanceId: unknown,
): ClientTurnObservationSupport | undefined {
  const expected = normalizeRemoteAgentPairingInstanceId(
    expectedServerInstanceId,
  );
  if (!expected) return;
  try {
    const input = plainRecord(status, "Peer status");
    if (
      normalizeRemoteAgentPairingInstanceId(input.serverInstanceId) !== expected
    )
      return;
    return readClientTurnObservationSupport(input.clientTurnObservationSupport);
  } catch {
    return;
  }
}

/** Browser-safe validation shared by the renderer and current-turn reader. */
export function parseClientCalendarDayObservation(
  value: unknown,
): ClientCalendarDayObservation {
  const input = plainRecord(value, "Calendar day");
  onlyKeys(input, CALENDAR_DAY_KEYS, "Calendar day");
  const date = matching(input.date, /^\d{4}-\d{2}-\d{2}$/, "Calendar day date");
  const [year, month, day] = date.split("-").map(Number);
  const civil = new Date(Date.UTC(year, month - 1, day));
  if (
    year < 1970 ||
    civil.getUTCFullYear() !== year ||
    civil.getUTCMonth() !== month - 1 ||
    civil.getUTCDate() !== day
  )
    throw new ClientTurnObservationError(
      "Calendar day must be a real civil date",
    );
  if (!isClientTimeZone(input.timeZone))
    throw new ClientTurnObservationError("Calendar day time zone is invalid");
  return Object.freeze({ date, timeZone: input.timeZone });
}

/** Browser-safe validation of a reported device position. */
export function parseClientLocationObservation(
  value: unknown,
): ClientLocationObservation {
  const input = plainRecord(value, "Device location");
  onlyKeys(input, LOCATION_KEYS, "Device location");
  const finite = (field: unknown, min: number, max: number, what: string) => {
    if (
      typeof field !== "number" ||
      !Number.isFinite(field) ||
      field < min ||
      field > max
    )
      throw new ClientTurnObservationError(
        `Device location ${what} is invalid`,
      );
    return field;
  };
  const latitude = finite(input.latitude, -90, 90, "latitude");
  const longitude = finite(input.longitude, -180, 180, "longitude");
  const accuracyMeters =
    input.accuracyMeters === undefined
      ? undefined
      : finite(input.accuracyMeters, 0, 1_000_000, "accuracy");
  if (
    typeof input.capturedAt !== "number" ||
    !Number.isSafeInteger(input.capturedAt) ||
    input.capturedAt < 0
  )
    throw new ClientTurnObservationError("Device location time is invalid");
  return Object.freeze({
    latitude,
    longitude,
    ...(accuracyMeters === undefined ? {} : { accuracyMeters }),
    capturedAt: input.capturedAt,
  });
}

function selectedObject(value: unknown): ClientSelectedObject {
  const input = plainRecord(value, "Selected object");
  onlyKeys(input, SELECTION_KEYS, "Selected object");
  const kind = matching(input.kind, NAME, "Selected object kind");
  const id = matching(input.id, IDENTIFIER, "Selected object identifier");
  let revision: string | undefined;
  if (input.revision !== undefined) {
    if (
      typeof input.revision !== "string" ||
      input.revision.length > REVISION_MAX_LENGTH ||
      !(TOKEN.test(input.revision) || ENTITY_TAG.test(input.revision))
    )
      throw new ClientTurnObservationError(
        "Selected object revision is invalid",
      );
    revision = input.revision;
  }
  const accountId = optionalToken(input.accountId, "Selected object source");
  const sourceRevision = optionalToken(
    input.sourceRevision,
    "Selected object source revision",
  );
  const occurrenceId = optionalToken(
    input.occurrenceId,
    "Selected object occurrence",
  );
  if (input.timingVersion !== undefined && input.timingVersion !== 2)
    throw new ClientTurnObservationError(
      "Selected object timing version is invalid",
    );
  return Object.freeze({
    kind,
    id,
    ...(revision === undefined ? {} : { revision }),
    ...(accountId === undefined ? {} : { accountId }),
    ...(sourceRevision === undefined ? {} : { sourceRevision }),
    ...(occurrenceId === undefined ? {} : { occurrenceId }),
    ...(input.timingVersion === 2 ? { timingVersion: 2 as const } : {}),
  });
}

/**
 * Strictly parses one observation. Unknown fields, prose-like identifiers,
 * control characters and oversized observations are rejected; nothing is
 * truncated or summarized. The result is frozen and has a canonical field
 * order, so its JSON form is stable for comparison.
 */
export function parseClientTurnObservation(
  value: unknown,
): ClientTurnObservation {
  const input = plainRecord(value, "Client observation");
  onlyKeys(input, OBSERVATION_KEYS, "Client observation");
  const view = matching(input.view, NAME, "Client observation view");
  if (
    typeof input.revision !== "number" ||
    !Number.isSafeInteger(input.revision) ||
    input.revision < 0
  )
    throw new ClientTurnObservationError(
      "Client observation revision is invalid",
    );
  if (input.sensitive !== undefined && typeof input.sensitive !== "boolean")
    throw new ClientTurnObservationError(
      "Client observation sensitivity is invalid",
    );
  const sensitive = input.sensitive === true;
  if (input.timeZone !== undefined && !isClientTimeZone(input.timeZone))
    throw new ClientTurnObservationError(
      "Client observation time zone is invalid",
    );
  if (sensitive && input.selectedObject !== undefined)
    throw new ClientTurnObservationError(
      "A sensitive screen cannot share a selected object",
    );
  const selection =
    input.selectedObject === undefined
      ? undefined
      : selectedObject(input.selectedObject);
  const calendarDay =
    input.calendarDay === undefined
      ? undefined
      : parseClientCalendarDayObservation(input.calendarDay);
  if (
    calendarDay &&
    (view !== "calendar" ||
      input.sensitive !== false ||
      input.timeZone !== calendarDay.timeZone)
  )
    throw new ClientTurnObservationError(
      "Calendar day requires the current non-sensitive Calendar and matching time zone",
    );
  const location =
    input.location === undefined
      ? undefined
      : parseClientLocationObservation(input.location);
  const observation: ClientTurnObservation = Object.freeze({
    view,
    revision: input.revision,
    sensitive,
    ...(input.timeZone === undefined
      ? {}
      : { timeZone: input.timeZone as string }),
    ...(selection ? { selectedObject: selection } : {}),
    ...(calendarDay ? { calendarDay } : {}),
    ...(location ? { location } : {}),
  });
  if (
    new TextEncoder().encode(JSON.stringify(observation)).byteLength >
    CLIENT_TURN_OBSERVATION_MAX_BYTES
  )
    throw new ClientTurnObservationError("Client observation is too large");
  return observation;
}

/**
 * Reads the observation from message content metadata. Returns undefined when
 * it is absent or does not satisfy the contract; it never throws, so callers
 * that fence on a valid observation keep their own fail-closed behavior.
 */
export function readClientTurnObservation(
  metadata: unknown,
): ClientTurnObservation | undefined {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata))
    return undefined;
  const device = (metadata as Record<string, unknown>).clientDevice;
  if (!device || typeof device !== "object" || Array.isArray(device))
    return undefined;
  try {
    return parseClientTurnObservation(
      (device as Record<string, unknown>).context,
    );
  } catch {
    return undefined;
  }
}
