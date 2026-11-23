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

/**
 * Optional observation fields a peer may declare it reads. `browserPage` is
 * carried beside the observation, as `clientDevice.browserPage`.
 */
export type ClientTurnObservationOptionalField =
  | "calendarDay"
  | "location"
  | "browserPage";
const OPTIONAL_FIELDS: readonly ClientTurnObservationOptionalField[] = [
  "calendarDay",
  "location",
  "browserPage",
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

/** Upper bound for the serialized Browser page, in UTF-8 bytes. */
export const CLIENT_BROWSER_PAGE_MAX_BYTES = 16_384;
/** The longest page text a client sends; it keeps the head and tail of a longer page. */
export const CLIENT_BROWSER_PAGE_TEXT_MAX = 6_000;
export const CLIENT_BROWSER_PAGE_TITLE_MAX = 300;
export const CLIENT_BROWSER_PAGE_SELECTION_MAX = 1_000;
export const CLIENT_BROWSER_PAGE_URL_MAX = 2_048;
export const CLIENT_BROWSER_PAGE_LINKS_MAX = 20;
export const CLIENT_BROWSER_PAGE_LINK_TEXT_MAX = 120;
/** Why a client left the page text out; the address and title are still the page's. */
export const CLIENT_BROWSER_PAGE_WITHHELD_REASONS = [
  "sensitive-page",
  "unreadable",
] as const;
export type ClientBrowserPageWithheldReason =
  (typeof CLIENT_BROWSER_PAGE_WITHHELD_REASONS)[number];

export interface ClientBrowserPageLink {
  /** The link's visible words. */
  readonly text: string;
  /** Absolute HTTPS target, without credentials or fragment. */
  readonly url: string;
}

/**
 * The public web page open in the phone's Browser when the owner sent the
 * message, carried as `clientDevice.browserPage` beside the observation. It is
 * web content: untrusted data the owner is looking at, never instructions and
 * never a grant to act. A client sends it only while Browser shows that tab,
 * never for a private tab, and only to a peer that declares `browserPage`. It
 * is bound to the observation's selected `browser-tab` by id and revision, so
 * a page from an earlier load is never shown as the current one.
 */
export interface ClientBrowserPageObservation {
  readonly tabId: string;
  readonly revision: string;
  readonly url: string;
  readonly title: string;
  /** When the client read the page, in epoch milliseconds. */
  readonly capturedAt: number;
  /** Present when the client sent no page text, selection or links. */
  readonly withheld?: ClientBrowserPageWithheldReason;
  /** Visible page text; a cut is marked in the text and by `truncated`. */
  readonly text?: string;
  readonly truncated?: boolean;
  /** Text the owner selected on the page. */
  readonly selection?: string;
  /** Links the page shows, in page order. */
  readonly links?: readonly ClientBrowserPageLink[];
}

const BROWSER_PAGE_KEYS = new Set([
  "tabId",
  "revision",
  "url",
  "title",
  "capturedAt",
  "withheld",
  "text",
  "truncated",
  "selection",
  "links",
]);
const BROWSER_LINK_KEYS = new Set(["text", "url"]);
// Page text keeps line breaks and tabs; every other control character is refused.
// biome-ignore lint/suspicious/noControlCharactersInRegex: page text must reject control characters.
const PAGE_CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029]/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: single-line fields reject every control character.
const LINE_CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

function pageString(
  value: unknown,
  max: number,
  multiline: boolean,
  what: string,
): string {
  if (
    typeof value !== "string" ||
    value.length > max ||
    (multiline ? PAGE_CONTROL : LINE_CONTROL).test(value) ||
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(
      value,
    )
  )
    throw new ClientTurnObservationError(`Browser page ${what} is invalid`);
  return value;
}

/** An absolute HTTPS address without credentials or fragment, in its parsed form. */
function pageUrl(value: unknown, what: string): string {
  if (typeof value !== "string" || value.length > CLIENT_BROWSER_PAGE_URL_MAX)
    throw new ClientTurnObservationError(`Browser page ${what} is invalid`);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ClientTurnObservationError(`Browser page ${what} is invalid`);
  }
  if (
    url.protocol !== "https:" ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.hash ||
    value.includes("#") ||
    url.href !== value
  )
    throw new ClientTurnObservationError(`Browser page ${what} is invalid`);
  return value;
}

/** Browser-safe validation of the open Browser page a client reports. */
export function parseClientBrowserPageObservation(
  value: unknown,
): ClientBrowserPageObservation {
  const input = plainRecord(value, "Browser page");
  onlyKeys(input, BROWSER_PAGE_KEYS, "Browser page");
  const tabId = matching(input.tabId, TOKEN, "Browser page tab");
  const revision = matching(input.revision, TOKEN, "Browser page revision");
  const url = pageUrl(input.url, "address");
  const title = pageString(
    input.title,
    CLIENT_BROWSER_PAGE_TITLE_MAX,
    false,
    "title",
  );
  if (
    typeof input.capturedAt !== "number" ||
    !Number.isSafeInteger(input.capturedAt) ||
    input.capturedAt < 0
  )
    throw new ClientTurnObservationError("Browser page time is invalid");
  let withheld: ClientBrowserPageWithheldReason | undefined;
  if (input.withheld !== undefined) {
    withheld = CLIENT_BROWSER_PAGE_WITHHELD_REASONS.find(
      (reason) => reason === input.withheld,
    );
    if (!withheld)
      throw new ClientTurnObservationError(
        "Browser page withheld reason is invalid",
      );
    if (
      input.text !== undefined ||
      input.truncated !== undefined ||
      input.selection !== undefined ||
      input.links !== undefined
    )
      throw new ClientTurnObservationError(
        "A withheld Browser page carries no page content",
      );
    return Object.freeze({
      tabId,
      revision,
      url,
      title,
      capturedAt: input.capturedAt,
      withheld,
    });
  }
  const text = pageString(
    input.text,
    CLIENT_BROWSER_PAGE_TEXT_MAX,
    true,
    "text",
  );
  if (typeof input.truncated !== "boolean")
    throw new ClientTurnObservationError("Browser page truncation is invalid");
  const selection =
    input.selection === undefined
      ? undefined
      : pageString(
          input.selection,
          CLIENT_BROWSER_PAGE_SELECTION_MAX,
          true,
          "selection",
        );
  let links: readonly ClientBrowserPageLink[] | undefined;
  if (input.links !== undefined) {
    if (
      !Array.isArray(input.links) ||
      input.links.length > CLIENT_BROWSER_PAGE_LINKS_MAX
    )
      throw new ClientTurnObservationError("Browser page links are invalid");
    links = Object.freeze(
      input.links.map((entry) => {
        const link = plainRecord(entry, "Browser page link");
        onlyKeys(link, BROWSER_LINK_KEYS, "Browser page link");
        const words = pageString(
          link.text,
          CLIENT_BROWSER_PAGE_LINK_TEXT_MAX,
          false,
          "link text",
        );
        if (!words.trim())
          throw new ClientTurnObservationError(
            "Browser page link text is empty",
          );
        return Object.freeze({ text: words, url: pageUrl(link.url, "link") });
      }),
    );
  }
  const page: ClientBrowserPageObservation = Object.freeze({
    tabId,
    revision,
    url,
    title,
    capturedAt: input.capturedAt,
    text,
    truncated: input.truncated,
    ...(selection === undefined ? {} : { selection }),
    ...(links === undefined ? {} : { links }),
  });
  if (
    new TextEncoder().encode(JSON.stringify(page)).byteLength >
    CLIENT_BROWSER_PAGE_MAX_BYTES
  )
    throw new ClientTurnObservationError("Browser page is too large");
  return page;
}

/**
 * True when the page is the one the observation shows: the non-sensitive
 * Browser view with that tab selected at that revision.
 */
export function browserPageMatchesObservation(
  page: ClientBrowserPageObservation,
  observation: ClientTurnObservation,
): boolean {
  const selected = observation.selectedObject;
  return (
    observation.view === "browser" &&
    !observation.sensitive &&
    selected?.kind === "browser-tab" &&
    selected.id === page.tabId &&
    selected.revision === page.revision
  );
}

/**
 * Reads `clientDevice.browserPage` when it is valid and bound to the valid
 * observation of the same message. Never throws.
 */
export function readClientBrowserPage(
  metadata: unknown,
): ClientBrowserPageObservation | undefined {
  const observation = readClientTurnObservation(metadata);
  if (!observation) return undefined;
  const device = (metadata as Record<string, unknown>).clientDevice as Record<
    string,
    unknown
  >;
  if (device.browserPage === undefined) return undefined;
  try {
    const page = parseClientBrowserPageObservation(device.browserPage);
    return browserPageMatchesObservation(page, observation) ? page : undefined;
  } catch {
    return undefined;
  }
}
