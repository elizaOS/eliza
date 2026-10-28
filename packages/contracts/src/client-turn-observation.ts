/**
 * Typed current-turn client observation, carried once per message as
 * `content.metadata.clientDevice.context`.
 *
 * A renderer reports which screen is visible and which record, if any, is
 * selected, using opaque identifiers only. The observation is untrusted data
 * for the message it accompanies: it carries no record contents, it is not an
 * instruction, and it grants no device access. Device-action admission,
 * planner hints and prompt assembly read it through this one contract, so a
 * client does not wrap the user's authored text in its own instruction
 * envelope. Product hosts may apply narrower view and selection allowlists
 * before sending; this contract only fixes the shared shape and bounds.
 */

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
]);
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
  const observation: ClientTurnObservation = Object.freeze({
    view,
    revision: input.revision,
    sensitive,
    ...(input.timeZone === undefined
      ? {}
      : { timeZone: input.timeZone as string }),
    ...(selection ? { selectedObject: selection } : {}),
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
