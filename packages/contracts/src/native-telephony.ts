/**
 * Renderer contract of the AOSP telephony profile: roles, SIMs, Contacts, SMS/MMS reads, reviewed
 * native sends, owner-placed calls and the phone's stored voicemail, served by a host subclass of the native `TelephonyPlugin`
 * (`@elizaos/plugin-native-messages`). A host registers that plugin only when its native admission
 * proves the install is the product's AOSP image; elsewhere this client refuses every call before
 * anything reaches native code.
 *
 * Text messaging has no account or OAuth grant: identity is the device's own subscriptions and the
 * user's Android default dialer and SMS roles. A handoff never reports a call or a send, and a placed
 * call reports only that Android accepted the request, never that it connected. A native
 * send returns the shared `sms.send.v1` result (`./sms-send.ts`): `submitted` proves only that Android
 * accepted the request, `sent` requires every sent callback, `delivered` every delivery report, and a
 * repeated operation ID reads its record and never sends again.
 */

import {
  mmsBindingText as contractMmsBindingText,
  MMS_ATTACHMENT_TYPES,
  MMS_MAX_ATTACHMENTS,
  MMS_MAX_BODY,
  MMS_MAX_RECIPIENTS,
  MMS_MAX_TOTAL_BYTES,
  type MmsAttachmentBinding,
  type MmsAttachmentType,
  type MmsSendOperation,
  validateMmsResult,
} from "./mms-send.ts";
import {
  smsBindingText as contractBindingText,
  type SmsSendOperation,
  type SmsSendResult,
  validateSmsResult,
} from "./sms-send.ts";

export type { MmsSendResult } from "./mms-send.ts";
export type { SmsSendResult } from "./sms-send.ts";

/** The native method whose presence in the injected plugin headers marks the admitted profile. */
export const TELEPHONY_PROFILE_METHOD = "imageCapability";

type PluginHeader = { name?: unknown; methods?: readonly { name?: unknown }[] };
/** True only for an Android bridge whose native side registered the profile-only plugin. */
export function detectTelephonyProfile(
  platform: string,
  headers: unknown,
  pluginName: string,
): boolean {
  if (platform !== "android" || !Array.isArray(headers)) return false;
  const header = (headers as PluginHeader[]).find(
    (entry) => entry?.name === pluginName,
  );
  return (
    !!header &&
    Array.isArray(header.methods) &&
    header.methods.some((method) => method?.name === TELEPHONY_PROFILE_METHOD)
  );
}

export type TelephonyPermissionState =
  | "granted"
  | "denied"
  | "prompt"
  | "prompt-with-rationale";
export type TelephonyRole = "dialer" | "sms";
/** `eligible`: the host declares the components Android requires before granting the role. Until
 * then a request is not offered, and the user's current dialer or SMS app keeps the role. */
export interface TelephonyRoleState {
  available: boolean;
  held: boolean;
  eligible: boolean;
}
/** One active subscription. Only present while the user has granted phone-state access. */
export interface TelephonySubscription {
  id: number;
  slot: number;
  displayName: string;
  carrierName: string;
  defaultSms: boolean;
  defaultVoice: boolean;
}
export interface TelephonyStatus {
  version: 2;
  voiceCapable: boolean;
  smsCapable: boolean;
  permissions: {
    contacts: TelephonyPermissionState;
    phoneState: TelephonyPermissionState;
    sms: TelephonyPermissionState;
    sendSms: TelephonyPermissionState;
    /** Present only when the host declares recent-call access (READ_CALL_LOG); absent means the
     * install has no recent-calls read at all, which is different from access not granted. */
    callLog?: TelephonyPermissionState;
  };
  /** `direct`: the host may send after its native review (SEND_SMS held, SIM readable). Otherwise only the SMS app handoff. */
  sendMode: "direct" | "handoff";
  /** The host can send a reviewed MMS (group messages and attachments) now: direct sends, the SMS
   * role (Android stores nothing for a default SMS app) and an MMS-capable carrier. Absent means false. */
  mmsSend: boolean;
  roles: Record<TelephonyRole, TelephonyRoleState>;
  /** Package Android uses today; null when none or unknown. */
  defaultDialer: string | null;
  defaultSms: string | null;
  /** Null until phone-state access is granted: an unread list is never presented as "no SIM". */
  subscriptions: TelephonySubscription[] | null;
  /** Android's default SMS subscription when it is one of the active SIMs above; otherwise null. */
  defaultSmsSubscriptionId: number | null;
}
export interface TelephonyContactCard {
  id: string;
  lookupKey: string;
  displayName: string;
  phoneNumbers: string[];
  emailAddresses: string[];
  starred: boolean;
}
export type TelephonyHandoffStatus =
  | "handed-off"
  | "unavailable"
  | "cancelled"
  | "failed";
/** A handoff names who owns the effect next. It is never "sent", "delivered" or "called". */
export interface TelephonyHandoffResult {
  status: TelephonyHandoffStatus;
  target: "dialer" | "sms";
  handler: string | null;
  message: string;
}
export type TelephonyAccessKind =
  | "contacts"
  | "phoneState"
  | "sms"
  | "sendSms"
  | "callLog";
export type TelephonyCallType =
  | "incoming"
  | "outgoing"
  | "missed"
  | "voicemail"
  | "rejected"
  | "blocked"
  | "answered_externally"
  | "unknown";
/** One recent call from the host's bounded, foreground-only call-log read. */
export interface TelephonyCallLogEntry {
  id: string;
  /** Digits with an optional leading +, or "" for a withheld or unknown caller. */
  number: string;
  cachedName: string | null;
  /** Epoch milliseconds. */
  date: number;
  durationSeconds: number;
  type: TelephonyCallType;
  isNew: boolean;
}
/** The largest recent-calls page a host returns in one read. */
export const TELEPHONY_CALL_LOG_MAX = 50;
/**
 * What became of a request to place a call. `placed`: Android's Telecom accepted the request, which
 * says nothing about ringing, connecting or being answered. `emergency-handoff`: the number is an
 * emergency number (or could not be classified), so nothing was placed and the dial screen is open
 * with it. `busy`: a call is already ringing or in progress; nothing was placed.
 */
export type PlaceCallStatus =
  | "placed"
  | "emergency-handoff"
  | "busy"
  | "unavailable"
  | "failed";
export interface PlaceCallResult {
  status: PlaceCallStatus;
  message: string;
}
/** What the phone's voicemail sources report for the default calling account. `unsupported`: no
 * source serves it, which is different from having no voicemail. */
export type VoicemailCarrierState = "ready" | "unconfigured" | "unsupported";
export interface VoicemailStatus {
  /** Whether this app may read voicemail (it is the default phone app). */
  access: boolean;
  /** Null exactly when there is no access: an unread state is never presented as `unsupported`. */
  state: VoicemailCarrierState | null;
}
/** One stored voicemail from the host's bounded, foreground-only read. */
export interface VoicemailEntry {
  id: string;
  /** Digits with an optional leading +, or "" for a withheld or unknown caller. */
  number: string;
  cachedName: string | null;
  /** Epoch milliseconds. */
  date: number;
  durationSeconds: number;
  /** Not yet marked heard. */
  isNew: boolean;
  /** The audio is on the phone; otherwise `fetchVoicemailAudio` asks its source to download it. */
  hasAudio: boolean;
  /** The carrier's own transcript when it stored one of at most 4000 characters; otherwise null. */
  carrierTranscript: string | null;
}
export interface VoicemailList {
  state: VoicemailCarrierState;
  /** Newest first. Always empty when `state` is `unsupported`. */
  voicemails: VoicemailEntry[];
}
/** `fetching` proves only that the voicemail's source was asked to download the audio. */
export type VoicemailFetchStatus = "ready" | "fetching" | "failed";
/** The stored audio exactly as the source saved it (often AMR or 3GPP). */
export interface VoicemailAudio {
  id: string;
  mimeType: string;
  /** Decoded byte length of `data`. */
  size: number;
  /** Base64. */
  data: string;
}
/** The voicemail decoded on the phone to 16 kHz mono 16-bit PCM in a WAV file, for transcription. */
export interface VoicemailPcm {
  mimeType: "audio/wav";
  sampleRateHz: 16000;
  durationSeconds: number;
  /** Base64 of the whole WAV file. */
  data: string;
}
/** The largest voicemail list a host returns in one read. */
export const VOICEMAIL_MAX = 50;
/** The largest stored audio `voicemailAudio` returns; a larger one is refused (`too-large`). */
export const VOICEMAIL_AUDIO_MAX_BYTES = 8 * 1024 * 1024;
/** The longest audio `voicemailPcm` decodes; a longer one is refused (`too-long`). */
export const VOICEMAIL_PCM_MAX_SECONDS = 300;
/** The largest WAV file `voicemailPcm` returns. */
export const VOICEMAIL_PCM_MAX_BYTES = 10 * 1024 * 1024;
export type PhoneNetworkType =
  | "none"
  | "2g"
  | "3g"
  | "4g"
  | "5g"
  | "wifi-calling"
  | "unknown";
/** One active SIM line of the owner's phone. A null field was not readable; it is not a value. */
export interface PhoneLine {
  subscriptionId: number;
  /** 0-based SIM slot. */
  slot: number;
  displayName: string;
  carrierName: string;
  /** The line's own number: digits with an optional leading +. Null when unknown or not readable. */
  number: string | null;
  /** Two lower-case letters. */
  countryIso: string | null;
  networkType: PhoneNetworkType;
  roaming: boolean | null;
  /** 0 to 4. */
  signalLevel: number | null;
  /** An eSIM. */
  embedded: boolean;
  /** Null without device-identifier access. */
  iccid: string | null;
  /** The slot's IMEI. Null without device-identifier access or on a slot that has none. */
  imei: string | null;
}
/** The phone's SIM lines from the host's bounded, foreground-only read, for a Settings page. */
export interface PhoneInfo {
  access: {
    /** False: the SIM list was not read, and `lines` is empty. That is not "no SIM". */
    phoneState: boolean;
    /** False: every `number` is null. */
    phoneNumbers: boolean;
    /** False: every `iccid` and `imei` is null. Android grants this only to privileged apps. */
    deviceIdentifiers: boolean;
  };
  /** At most 4, ordered by slot. */
  lines: PhoneLine[];
}
/** The most SIM lines `phoneInfo` returns. */
export const PHONE_INFO_MAX_LINES = 4;
/** The native bridge surface of a host's `TelephonyPlugin` subclass. Results are untrusted until parsed. */
export interface TelephonyNativePlugin {
  imageCapability(): Promise<unknown>;
  status(): Promise<unknown>;
  requestAccess(options: { access: TelephonyAccessKind }): Promise<unknown>;
  requestRole(options: { role: TelephonyRole }): Promise<unknown>;
  searchContacts(options: { query: string; limit: number }): Promise<unknown>;
  /** Bounded recent calls, newest first, of one number when `number` is set. Only hosts that declare
   * recent-call access implement it. */
  listRecentCalls?(options: {
    limit: number;
    number?: string;
  }): Promise<unknown>;
  dial(options: { number: string }): Promise<unknown>;
  /** Asks Telecom for a call. Needs the dialer role and CALL_PHONE; rejects with code
   * `role-required` or `permission-required` without them. */
  placeCall?(options: { number: string }): Promise<unknown>;
  /** The owner's SIM lines, numbers and device identifiers, each only as far as Android allows. */
  phoneInfo?(): Promise<unknown>;
  voicemailStatus?(): Promise<unknown>;
  listVoicemail?(options: { limit: number }): Promise<unknown>;
  /** Rejects with code `not-found` when the voicemail is gone. */
  fetchVoicemailAudio?(options: { id: string }): Promise<unknown>;
  /** Rejects with code `not-found`, `not-ready` (audio not downloaded) or `too-large`. */
  voicemailAudio?(options: { id: string }): Promise<unknown>;
  /** Rejects with code `not-found`, `not-ready`, `too-long`, `too-large` or `undecodable`. */
  voicemailPcm?(options: { id: string }): Promise<unknown>;
  markVoicemailHeard?(options: { id: string }): Promise<unknown>;
  deleteVoicemail?(options: { id: string }): Promise<unknown>;
  observeVoicemail?(options: { enabled: boolean }): Promise<unknown>;
  composeSms(options: { recipients: string[]; body: string }): Promise<unknown>;
  listThreads(options: {
    limit: number;
    before?: number;
    cursor?: string;
  }): Promise<unknown>;
  listMessages(options: {
    threadId: string;
    limit: number;
    before?: number;
    cursor?: string;
  }): Promise<unknown>;
  observeMessages(options: { enabled: boolean }): Promise<unknown>;
  markThreadRead(options: {
    threadId: string;
    throughDate: number;
  }): Promise<unknown>;
  sendSms(options: {
    operationId: string;
    recipients: string[];
    body: string;
    subscriptionId: number;
  }): Promise<unknown>;
  cancelSmsReview(options: { operationId: string }): Promise<unknown>;
  /** One reviewed MMS to every recipient. `data` is base64 of the exact bytes bound by `sha256`. */
  sendMms?(options: {
    operationId: string;
    recipients: string[];
    body: string;
    attachments: (MmsAttachmentBinding & { data: string })[];
    subscriptionId: number;
  }): Promise<unknown>;
  mmsSendResult?(options: { operationId: string }): Promise<unknown>;
  smsSendHistory(): Promise<unknown>;
  smsSendResult(options: { operationId: string }): Promise<unknown>;
  addListener?(
    event:
      | "messagesChanged"
      | "smsSendUpdated"
      | "mmsSendUpdated"
      | "voicemailChanged",
    listener: (data: unknown) => void,
  ): Promise<{ remove(): Promise<void> | void }>;
}

export class TelephonyUnavailable extends Error {
  readonly name = "TelephonyUnavailable";
  constructor(
    message = "Phone, Contacts and Messages are available only on the phone's system image.",
  ) {
    super(message);
  }
}
/**
 * A reviewed native send that was never attempted: nothing was recorded or sent, so the same
 * operation ID may be reviewed again. "busy": another review is open. "closed": the review dialog
 * could not be shown.
 */
export class SmsSendNotAttempted extends Error {
  readonly name = "SmsSendNotAttempted";
  readonly operationId: string;
  readonly reason: "busy" | "closed";
  constructor(operationId: string, reason: "busy" | "closed") {
    super(
      reason === "busy"
        ? "Another message is waiting for review. Nothing was sent."
        : "The review could not be shown. Nothing was sent.",
    );
    this.operationId = operationId;
    this.reason = reason;
  }
}
const invalid = (what: string) =>
  new Error(`Telephony returned an invalid ${what}`);
const object = (value: unknown, what: string): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw invalid(what);
  return value as Record<string, unknown>;
};
const bool = (value: unknown, what: string) => {
  if (typeof value !== "boolean") throw invalid(what);
  return value;
};
const text = (value: unknown, what: string, max = 256) => {
  if (typeof value !== "string" || value.length > max) throw invalid(what);
  return value;
};
const nullableText = (value: unknown, what: string) =>
  value === null || value === undefined ? null : text(value, what);
const PERMISSIONS: readonly TelephonyPermissionState[] = [
  "granted",
  "denied",
  "prompt",
  "prompt-with-rationale",
];
const permission = (value: unknown, what: string): TelephonyPermissionState => {
  if (!PERMISSIONS.includes(value as TelephonyPermissionState))
    throw invalid(what);
  return value as TelephonyPermissionState;
};

export function parseImageCapability(value: unknown): {
  version: 1;
  image: true;
  feature: string;
} {
  const data = object(value, "image capability");
  if (data.version !== 1 || data.image !== true)
    throw invalid("image capability");
  return {
    version: 1,
    image: true,
    feature: text(data.feature, "image feature"),
  };
}

export function parseTelephonyStatus(value: unknown): TelephonyStatus {
  const data = object(value, "status");
  if (data.version !== 2) throw invalid("status version");
  const permissions = object(data.permissions, "permissions");
  const roles = object(data.roles, "roles");
  const role = (name: TelephonyRole): TelephonyRoleState => {
    const r = object(roles[name], `${name} role`);
    const available = bool(r.available, `${name} role`);
    const held = bool(r.held, `${name} role`);
    const eligible = bool(r.eligible, `${name} role`);
    if (held && !available) throw invalid(`${name} role`);
    return { available, held, eligible };
  };
  const phoneState = permission(
    permissions.phoneState,
    "phone-state permission",
  );
  let subscriptions: TelephonySubscription[] | null = null;
  if (data.subscriptions !== null && data.subscriptions !== undefined) {
    // A list read without phone-state access cannot be trusted as the device's SIM inventory.
    if (
      !Array.isArray(data.subscriptions) ||
      data.subscriptions.length > 8 ||
      phoneState !== "granted"
    )
      throw invalid("subscriptions");
    const seen = new Set<number>();
    subscriptions = data.subscriptions.map((row) => {
      const s = object(row, "subscription");
      if (
        !Number.isSafeInteger(s.id) ||
        (s.id as number) < 0 ||
        seen.has(s.id as number) ||
        !Number.isSafeInteger(s.slot) ||
        (s.slot as number) < 0
      )
        throw invalid("subscription");
      seen.add(s.id as number);
      return {
        id: s.id as number,
        slot: s.slot as number,
        displayName: text(s.displayName, "subscription name"),
        carrierName: text(s.carrierName, "carrier name"),
        defaultSms: bool(s.defaultSms, "subscription"),
        defaultVoice: bool(s.defaultVoice, "subscription"),
      };
    });
  }
  const sendSms = permission(permissions.sendSms, "send permission");
  const smsCapable = bool(data.smsCapable, "SMS capability");
  if (data.sendMode !== "direct" && data.sendMode !== "handoff")
    throw invalid("send mode");
  // Direct sends need the send permission, a readable SIM list and SMS hardware; a claim without them is refused.
  if (
    data.sendMode === "direct" &&
    (sendSms !== "granted" || phoneState !== "granted" || !smsCapable)
  )
    throw invalid("send mode");
  let defaultSmsSubscriptionId: number | null = null;
  if (
    data.defaultSmsSubscriptionId !== null &&
    data.defaultSmsSubscriptionId !== undefined
  ) {
    const marked = subscriptions?.filter((sim) => sim.defaultSms) ?? [];
    if (marked.length !== 1 || marked[0].id !== data.defaultSmsSubscriptionId)
      throw invalid("default SMS subscription");
    defaultSmsSubscriptionId = marked[0].id;
  }
  const mmsSend =
    data.mmsSend === undefined ? false : bool(data.mmsSend, "MMS send");
  if (mmsSend && data.sendMode !== "direct") throw invalid("MMS send");
  return {
    version: 2,
    voiceCapable: bool(data.voiceCapable, "voice capability"),
    smsCapable,
    permissions: {
      contacts: permission(permissions.contacts, "contacts permission"),
      phoneState,
      sms: permission(permissions.sms, "SMS permission"),
      sendSms,
      ...(permissions.callLog === undefined
        ? {}
        : { callLog: permission(permissions.callLog, "call-log permission") }),
    },
    sendMode: data.sendMode,
    mmsSend,
    roles: { dialer: role("dialer"), sms: role("sms") },
    defaultDialer: nullableText(data.defaultDialer, "default dialer"),
    defaultSms: nullableText(data.defaultSms, "default SMS app"),
    subscriptions,
    defaultSmsSubscriptionId,
  };
}

export function parseContacts(
  value: unknown,
  limit: number,
): TelephonyContactCard[] {
  const data = object(value, "contacts");
  if (!Array.isArray(data.contacts) || data.contacts.length > limit)
    throw invalid("contacts");
  const strings = (list: unknown, what: string) => {
    if (!Array.isArray(list) || list.length > 32) throw invalid(what);
    return list.map((item) => text(item, what));
  };
  return data.contacts.map((row) => {
    const c = object(row, "contact");
    return {
      id: text(c.id, "contact id", 64),
      lookupKey: text(c.lookupKey, "contact lookup key", 512),
      displayName: text(c.displayName, "contact name"),
      phoneNumbers: strings(c.phoneNumbers, "contact numbers"),
      emailAddresses: strings(c.emailAddresses, "contact emails"),
      starred: bool(c.starred, "contact"),
    };
  });
}

const CALL_TYPES: readonly TelephonyCallType[] = [
  "incoming",
  "outgoing",
  "missed",
  "voicemail",
  "rejected",
  "blocked",
  "answered_externally",
  "unknown",
];
/** Parses a recent-calls page. A longer page than requested, a repeated ID or an unreadable row is refused. */
export function parseCallLog(
  value: unknown,
  limit: number,
): TelephonyCallLogEntry[] {
  const data = object(value, "recent calls");
  if (!Array.isArray(data.calls) || data.calls.length > limit)
    throw invalid("recent calls");
  const seen = new Set<string>();
  let previous = Number.POSITIVE_INFINITY;
  return data.calls.map((row) => {
    const c = object(row, "recent call");
    const id = text(c.id, "call id", 32);
    if (!/^[0-9]+$/.test(id) || seen.has(id)) throw invalid("call id");
    seen.add(id);
    const number = text(c.number, "call number", 21);
    if (number !== "" && !/^\+?[0-9]{2,20}$/.test(number))
      throw invalid("call number");
    if (
      !Number.isSafeInteger(c.date) ||
      (c.date as number) <= 0 ||
      (c.date as number) > previous ||
      !Number.isSafeInteger(c.durationSeconds) ||
      (c.durationSeconds as number) < 0 ||
      !CALL_TYPES.includes(c.type as TelephonyCallType)
    )
      throw invalid("recent call");
    previous = c.date as number;
    return {
      id,
      number,
      cachedName: nullableText(c.cachedName, "call name"),
      date: c.date as number,
      durationSeconds: c.durationSeconds as number,
      type: c.type as TelephonyCallType,
      isNew: bool(c.isNew, "recent call"),
    };
  });
}

const HANDOFF: readonly TelephonyHandoffStatus[] = [
  "handed-off",
  "unavailable",
  "cancelled",
  "failed",
];
export function parseHandoff(
  value: unknown,
  target: "dialer" | "sms",
): TelephonyHandoffResult {
  const data = object(value, "handoff");
  if (
    !HANDOFF.includes(data.status as TelephonyHandoffStatus) ||
    data.target !== target
  )
    throw invalid("handoff");
  return {
    status: data.status as TelephonyHandoffStatus,
    target,
    handler: nullableText(data.handler, "handoff handler"),
    message: text(data.message, "handoff message", 1024),
  };
}

/** Refuses a result that carries a field the contract does not name, or lacks one it does. */
const exact = (
  data: Record<string, unknown>,
  keys: readonly string[],
  what: string,
) => {
  const present = Object.keys(data);
  if (
    present.length !== keys.length ||
    !keys.every((key) => Object.hasOwn(data, key))
  )
    throw invalid(what);
};
const PLACE_CALL: readonly PlaceCallStatus[] = [
  "placed",
  "emergency-handoff",
  "busy",
  "unavailable",
  "failed",
];
/** Parses a place-call result. Nothing in it can say a call connected. */
export function parsePlaceCall(value: unknown): PlaceCallResult {
  const data = object(value, "call request");
  exact(data, ["status", "message"], "call request");
  if (!PLACE_CALL.includes(data.status as PlaceCallStatus))
    throw invalid("call request");
  return {
    status: data.status as PlaceCallStatus,
    message: text(data.message, "call request message", 1024),
  };
}

const VOICEMAIL_STATES: readonly VoicemailCarrierState[] = [
  "ready",
  "unconfigured",
  "unsupported",
];
const VOICEMAIL_ID = /^[1-9]\d{0,17}$/;
const voicemailState = (value: unknown): VoicemailCarrierState => {
  if (!VOICEMAIL_STATES.includes(value as VoicemailCarrierState))
    throw invalid("voicemail state");
  return value as VoicemailCarrierState;
};
/** Parses the voicemail status. A state without access, or access without a state, is refused. */
export function parseVoicemailStatus(value: unknown): VoicemailStatus {
  const data = object(value, "voicemail status");
  exact(data, ["access", "state"], "voicemail status");
  const access = bool(data.access, "voicemail access");
  if (!access) {
    if (data.state !== null) throw invalid("voicemail state");
    return { access, state: null };
  }
  return { access, state: voicemailState(data.state) };
}
const VOICEMAIL_FIELDS = [
  "id",
  "number",
  "cachedName",
  "date",
  "durationSeconds",
  "isNew",
  "hasAudio",
  "carrierTranscript",
] as const;
/** Parses a voicemail list. A longer list than requested, a repeated ID, rows out of order, an
 * unknown field, or any row under an `unsupported` state is refused. */
export function parseVoicemailList(
  value: unknown,
  limit: number,
): VoicemailList {
  const data = object(value, "voicemail list");
  exact(data, ["state", "voicemails"], "voicemail list");
  const state = voicemailState(data.state);
  if (
    !Array.isArray(data.voicemails) ||
    data.voicemails.length > limit ||
    (state === "unsupported" && data.voicemails.length > 0)
  )
    throw invalid("voicemail list");
  const seen = new Set<string>();
  let previous = Number.POSITIVE_INFINITY;
  const voicemails = data.voicemails.map((row): VoicemailEntry => {
    const v = object(row, "voicemail");
    exact(v, VOICEMAIL_FIELDS, "voicemail");
    const id = text(v.id, "voicemail id", 18);
    if (!VOICEMAIL_ID.test(id) || seen.has(id)) throw invalid("voicemail id");
    seen.add(id);
    const number = text(v.number, "voicemail number", 21);
    if (number !== "" && !/^\+?[0-9]{2,20}$/.test(number))
      throw invalid("voicemail number");
    if (
      !Number.isSafeInteger(v.date) ||
      (v.date as number) <= 0 ||
      (v.date as number) > previous ||
      !Number.isSafeInteger(v.durationSeconds) ||
      (v.durationSeconds as number) < 0
    )
      throw invalid("voicemail");
    previous = v.date as number;
    const transcript =
      v.carrierTranscript === null
        ? null
        : text(v.carrierTranscript, "voicemail transcript", 4000);
    if (transcript !== null && !transcript.trim())
      throw invalid("voicemail transcript");
    return {
      id,
      number,
      cachedName: v.cachedName === null ? null : text(v.cachedName, "caller"),
      date: v.date as number,
      durationSeconds: v.durationSeconds as number,
      isNew: bool(v.isNew, "voicemail"),
      hasAudio: bool(v.hasAudio, "voicemail"),
      carrierTranscript: transcript,
    };
  });
  return { state, voicemails };
}
const VOICEMAIL_FETCH: readonly VoicemailFetchStatus[] = [
  "ready",
  "fetching",
  "failed",
];
export function parseVoicemailFetch(value: unknown): VoicemailFetchStatus {
  const data = object(value, "voicemail fetch");
  exact(data, ["status"], "voicemail fetch");
  if (!VOICEMAIL_FETCH.includes(data.status as VoicemailFetchStatus))
    throw invalid("voicemail fetch");
  return data.status as VoicemailFetchStatus;
}
/** The decoded byte length of canonical padded base64 of at most `maxBytes`; anything else is refused. */
function base64Bytes(value: unknown, maxBytes: number, what: string): number {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length % 4 !== 0 ||
    value.length > Math.ceil(maxBytes / 3) * 4 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(value)
  )
    throw invalid(what);
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const bytes = (value.length / 4) * 3 - padding;
  if (bytes < 1 || bytes > maxBytes) throw invalid(what);
  return bytes;
}
/** Parses stored voicemail audio: the requested voicemail, an audio type, and exactly `size` bytes
 * within the bound. */
export function parseVoicemailAudio(
  value: unknown,
  id: string,
): VoicemailAudio {
  const data = object(value, "voicemail audio");
  exact(data, ["id", "mimeType", "size", "data"], "voicemail audio");
  const mimeType = text(data.mimeType, "voicemail audio type", 70);
  if (
    data.id !== id ||
    !/^audio\/[A-Za-z0-9][A-Za-z0-9.+-]{0,63}$/.test(mimeType) ||
    base64Bytes(data.data, VOICEMAIL_AUDIO_MAX_BYTES, "voicemail audio") !==
      data.size
  )
    throw invalid("voicemail audio");
  return { id, mimeType, size: data.size as number, data: data.data as string };
}
/** Parses decoded voicemail PCM: a 16 kHz mono WAV whose byte length matches its stated duration,
 * within the five-minute and size bounds. The WAV header itself is the transcriber's to read. */
export function parseVoicemailPcm(value: unknown): VoicemailPcm {
  const data = object(value, "voicemail PCM");
  exact(
    data,
    ["mimeType", "sampleRateHz", "durationSeconds", "data"],
    "voicemail PCM",
  );
  const bytes = base64Bytes(
    data.data,
    VOICEMAIL_PCM_MAX_BYTES,
    "voicemail PCM",
  );
  const samples = (bytes - 44) / 2;
  const duration = data.durationSeconds;
  if (
    data.mimeType !== "audio/wav" ||
    data.sampleRateHz !== 16000 ||
    !Number.isSafeInteger(samples) ||
    samples < 1 ||
    typeof duration !== "number" ||
    !Number.isFinite(duration) ||
    duration <= 0 ||
    duration > VOICEMAIL_PCM_MAX_SECONDS ||
    Math.abs(duration - samples / 16000) > 0.001
  )
    throw invalid("voicemail PCM");
  return {
    mimeType: "audio/wav",
    sampleRateHz: 16000,
    durationSeconds: duration,
    data: data.data as string,
  };
}
function parseVoicemailWrite<S extends string>(
  value: unknown,
  done: S,
): S | "not-found" {
  const data = object(value, "voicemail change");
  exact(data, ["status"], "voicemail change");
  if (data.status !== done && data.status !== "not-found")
    throw invalid("voicemail change");
  return data.status as S | "not-found";
}

const PHONE_NETWORK_TYPES: readonly PhoneNetworkType[] = [
  "none",
  "2g",
  "3g",
  "4g",
  "5g",
  "wifi-calling",
  "unknown",
];
const PHONE_LINE_FIELDS = [
  "subscriptionId",
  "slot",
  "displayName",
  "carrierName",
  "number",
  "countryIso",
  "networkType",
  "roaming",
  "signalLevel",
  "embedded",
  "iccid",
  "imei",
] as const;
/** A nullable string of one shape; a present value that does not match is refused. */
const shaped = (value: unknown, shape: RegExp, what: string) => {
  if (value === null) return null;
  if (typeof value !== "string" || !shape.test(value)) throw invalid(what);
  return value;
};
/**
 * Parses the phone's SIM lines. Refused: an unknown or missing field, more than 4 lines, a repeated
 * subscription, lines out of slot order, lines without phone-state access, a number without
 * phone-number access, and an ICCID or IMEI without device-identifier access.
 */
export function parsePhoneInfo(value: unknown): PhoneInfo {
  const data = object(value, "phone information");
  exact(data, ["access", "lines"], "phone information");
  const granted = object(data.access, "phone access");
  exact(
    granted,
    ["phoneState", "phoneNumbers", "deviceIdentifiers"],
    "phone access",
  );
  const access = {
    phoneState: bool(granted.phoneState, "phone access"),
    phoneNumbers: bool(granted.phoneNumbers, "phone access"),
    deviceIdentifiers: bool(granted.deviceIdentifiers, "phone access"),
  };
  if (
    !Array.isArray(data.lines) ||
    data.lines.length > PHONE_INFO_MAX_LINES ||
    (!access.phoneState && data.lines.length > 0)
  )
    throw invalid("phone lines");
  const seen = new Set<number>();
  let previousSlot = 0;
  const lines = data.lines.map((row): PhoneLine => {
    const l = object(row, "phone line");
    exact(l, PHONE_LINE_FIELDS, "phone line");
    const subscriptionId = count(l.subscriptionId, "phone line subscription");
    const slot = count(l.slot, "phone line slot");
    if (seen.has(subscriptionId) || slot < previousSlot)
      throw invalid("phone line");
    seen.add(subscriptionId);
    previousSlot = slot;
    const number = shaped(
      l.number,
      /^(\+[0-9]{1,31}|[0-9]{1,32})$/,
      "phone line number",
    );
    const iccid = shaped(
      l.iccid,
      /^([0-9]{1,21}F?|[0-9]{22})$/,
      "phone line ICCID",
    );
    const imei = shaped(l.imei, /^[0-9]{14,16}$/, "phone line IMEI");
    if (number !== null && !access.phoneNumbers)
      throw invalid("phone line number");
    if ((iccid !== null || imei !== null) && !access.deviceIdentifiers)
      throw invalid("phone line identifier");
    if (!PHONE_NETWORK_TYPES.includes(l.networkType as PhoneNetworkType))
      throw invalid("phone line network");
    if (
      l.signalLevel !== null &&
      (!Number.isSafeInteger(l.signalLevel) ||
        (l.signalLevel as number) < 0 ||
        (l.signalLevel as number) > 4)
    )
      throw invalid("phone line signal");
    return {
      subscriptionId,
      slot,
      displayName: text(l.displayName, "phone line name", 64),
      carrierName: text(l.carrierName, "phone line carrier", 64),
      number,
      countryIso: shaped(l.countryIso, /^[a-z]{2}$/, "phone line country"),
      networkType: l.networkType as PhoneNetworkType,
      roaming: l.roaming === null ? null : bool(l.roaming, "phone line"),
      signalLevel: l.signalLevel as number | null,
      embedded: bool(l.embedded, "phone line"),
      iccid,
      imei,
    };
  });
  return { access, lines };
}

/** A dialable number: digits with an optional leading +, and the separators people type. Letters,
 * USSD/MMI sequences and pauses are refused here; the system dialer remains available for them. */
export function normalizePhoneNumber(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!/^\+?[\d\s().-]{2,40}$/.test(trimmed)) return null;
  const digits = trimmed.replace(/[\s().-]/g, "");
  return /^\+?\d{2,20}$/.test(digits) ? digits : null;
}

/** The reviewed content of one outgoing text. The user sees exactly this before anything leaves the app. */
export interface SmsReview {
  recipients: string[];
  body: string;
  subscriptionId: number | null;
}
export const SMS_MAX_RECIPIENTS = 10;
export const SMS_MAX_BODY = 5000;
/** Bounds of a native send, equal to the shared `sms.send.v1` contract. */
export const SMS_DIRECT_MAX_RECIPIENTS = 5;
export const SMS_DIRECT_MAX_BODY = 1600;
export type SmsReviewProblem =
  | "no-recipient"
  | "invalid-recipient"
  | "too-many-recipients"
  | "empty-body"
  | "body-too-long"
  | "invalid-body"
  | "sim-unknown"
  | "sim-required"
  | "sim-not-selectable";
const LONE_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;
/** Validates a draft against the current status. A handoff leaves the SIM to the SMS app, so a SIM
 * choice is refused there rather than silently dropped. A direct send needs one active SIM, or the
 * user's explicit choice among several; a subscription that is not active now is refused rather than
 * silently replaced. */
export function reviewSms(
  draft: { recipients: unknown[]; body: unknown; subscriptionId?: unknown },
  status: TelephonyStatus,
  mode: "handoff" | "direct" = "handoff",
): { review: SmsReview } | { problem: SmsReviewProblem } {
  if (!Array.isArray(draft.recipients) || !draft.recipients.length)
    return { problem: "no-recipient" };
  if (
    draft.recipients.length >
    (mode === "direct" ? SMS_DIRECT_MAX_RECIPIENTS : SMS_MAX_RECIPIENTS)
  )
    return { problem: "too-many-recipients" };
  const recipients: string[] = [];
  for (const raw of draft.recipients) {
    const number = normalizePhoneNumber(raw);
    if (!number) return { problem: "invalid-recipient" };
    if (!recipients.includes(number)) recipients.push(number);
  }
  if (typeof draft.body !== "string" || !draft.body.trim())
    return { problem: "empty-body" };
  if (
    draft.body.length > (mode === "direct" ? SMS_DIRECT_MAX_BODY : SMS_MAX_BODY)
  )
    return { problem: "body-too-long" };
  if (
    mode === "direct" &&
    (draft.body.includes("\0") || LONE_SURROGATE.test(draft.body))
  )
    return { problem: "invalid-body" };
  const active = status.subscriptions;
  const chosen =
    draft.subscriptionId !== undefined && draft.subscriptionId !== null;
  if (mode === "handoff")
    return chosen
      ? { problem: "sim-not-selectable" }
      : { review: { recipients, body: draft.body, subscriptionId: null } };
  if (!active) return { problem: "sim-unknown" };
  let subscriptionId: number;
  if (chosen) {
    if (!active.some((sim) => sim.id === draft.subscriptionId))
      return { problem: "sim-unknown" };
    subscriptionId = draft.subscriptionId as number;
  } else if (active.length !== 1)
    return { problem: active.length ? "sim-required" : "sim-unknown" };
  else subscriptionId = active[0].id;
  return { review: { recipients, body: draft.body, subscriptionId } };
}

/**
 * Outgoing message states. A handoff ends the app's part; a direct send records the radio's report.
 * `outcome-unknown` and `handed-off` are terminal: neither may be repeated automatically, because the
 * message may exist.
 */
export type SmsSendState =
  | "reviewed"
  | "handed-off"
  | "dispatched"
  | "sent"
  | "delivered"
  | "failed"
  | "outcome-unknown";
const SMS_NEXT: Record<SmsSendState, readonly SmsSendState[]> = {
  reviewed: ["handed-off", "dispatched", "failed"],
  dispatched: ["sent", "failed", "outcome-unknown"],
  sent: ["delivered"],
  "handed-off": [],
  delivered: [],
  failed: [],
  "outcome-unknown": [],
};
export function advanceSmsState(
  from: SmsSendState,
  to: SmsSendState,
): SmsSendState {
  if (!SMS_NEXT[from].includes(to))
    throw new Error(`An outgoing message cannot move from ${from} to ${to}`);
  return to;
}
/** Only a review that never left the app, or a send the radio definitively refused, may be offered
 * again, and then only as a new explicit review. */
export function smsMayBeReviewedAgain(state: SmsSendState): boolean {
  return state === "reviewed" || state === "failed";
}

/** One attachment of an MMS draft: the exact bytes the owner picked. */
export interface MmsAttachmentDraft {
  contentType: string;
  name: string;
  bytes: Uint8Array;
}
/** The reviewed content of one outgoing MMS (a group conversation when there are several recipients). */
export interface MmsReview {
  recipients: string[];
  body: string;
  attachments: {
    contentType: MmsAttachmentType;
    name: string;
    bytes: Uint8Array;
  }[];
  subscriptionId: number;
}
export type MmsReviewProblem =
  | SmsReviewProblem
  | "empty-message"
  | "too-many-attachments"
  | "attachment-type"
  | "attachment-name"
  | "attachment-empty"
  | "too-large"
  | "mms-unavailable";
const MMS_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/**
 * Validates an MMS draft for a direct send against the current status. Group messages and
 * attachments always go as one MMS; the same SIM rules as `reviewSms` direct sends apply.
 */
export function reviewMms(
  draft: {
    recipients: unknown[];
    body: unknown;
    attachments?: readonly MmsAttachmentDraft[];
    subscriptionId?: unknown;
  },
  status: TelephonyStatus,
): { review: MmsReview } | { problem: MmsReviewProblem } {
  if (!status.mmsSend) return { problem: "mms-unavailable" };
  if (!Array.isArray(draft.recipients) || !draft.recipients.length)
    return { problem: "no-recipient" };
  if (draft.recipients.length > MMS_MAX_RECIPIENTS)
    return { problem: "too-many-recipients" };
  const recipients: string[] = [];
  for (const raw of draft.recipients) {
    const number = normalizePhoneNumber(raw);
    if (!number) return { problem: "invalid-recipient" };
    if (!recipients.includes(number)) recipients.push(number);
  }
  const body = typeof draft.body === "string" ? draft.body : "";
  if (body.length > MMS_MAX_BODY) return { problem: "body-too-long" };
  if (body.includes("\0") || LONE_SURROGATE.test(body))
    return { problem: "invalid-body" };
  const attachments = draft.attachments ?? [];
  if (attachments.length > MMS_MAX_ATTACHMENTS)
    return { problem: "too-many-attachments" };
  let total = 0;
  const names = new Set<string>();
  for (const a of attachments) {
    if (!MMS_ATTACHMENT_TYPES.includes(a.contentType as MmsAttachmentType))
      return { problem: "attachment-type" };
    if (!MMS_NAME.test(a.name) || names.has(a.name))
      return { problem: "attachment-name" };
    if (!(a.bytes instanceof Uint8Array) || !a.bytes.length)
      return { problem: "attachment-empty" };
    names.add(a.name);
    total += a.bytes.length;
  }
  if (total > MMS_MAX_TOTAL_BYTES) return { problem: "too-large" };
  if (!body.trim() && !attachments.length) return { problem: "empty-message" };
  const active = status.subscriptions;
  if (!active) return { problem: "sim-unknown" };
  const chosen =
    draft.subscriptionId !== undefined && draft.subscriptionId !== null;
  let subscriptionId: number;
  if (chosen) {
    if (!active.some((sim) => sim.id === draft.subscriptionId))
      return { problem: "sim-unknown" };
    subscriptionId = draft.subscriptionId as number;
  } else if (active.length !== 1)
    return { problem: active.length ? "sim-required" : "sim-unknown" };
  else subscriptionId = active[0].id;
  return {
    review: {
      recipients,
      body,
      attachments: attachments.map((a) => ({
        contentType: a.contentType as MmsAttachmentType,
        name: a.name,
        bytes: a.bytes,
      })),
      subscriptionId,
    },
  };
}
const hex = (digest: ArrayBuffer) =>
  Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
async function mmsOperation(review: MmsReview): Promise<MmsSendOperation> {
  const attachments: MmsAttachmentBinding[] = [];
  for (const a of review.attachments)
    attachments.push({
      contentType: a.contentType,
      name: a.name,
      sha256: hex(
        await crypto.subtle.digest("SHA-256", new Uint8Array(a.bytes)),
      ),
      size: a.bytes.length,
    });
  return {
    type: "mms_send",
    recipients: review.recipients,
    body: review.body,
    attachments,
    subscriptionId: review.subscriptionId,
  };
}
/** The shared `mms.send.v1` binding of a review and its UTF-8 SHA-256, as the native journal computes them. */
export async function mmsBinding(
  review: MmsReview,
): Promise<{ operation: MmsSendOperation; text: string; hash: string }> {
  const operation = await mmsOperation(review);
  const text = contractMmsBindingText(operation);
  const hash = hex(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
  );
  return { operation, text, hash };
}
function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

export type MessageDirection = "incoming" | "outgoing";
/** Incoming: received or read. Outgoing: pending, sent, failed or delivered (SMS delivery report only). */
export type MessageStatus =
  | "received"
  | "read"
  | "pending"
  | "sent"
  | "failed"
  | "delivered";
export interface SmsThread {
  id: string;
  date: number;
  messageCount: number;
  snippet: string;
  unread: boolean;
  addresses: string[];
}
export interface SmsMessage {
  /** Stable: `sms:<row>` or `mms:<row>`. */
  id: string;
  kind: "sms" | "mms";
  threadId: string;
  direction: MessageDirection;
  status: MessageStatus;
  date: number;
  read: boolean;
  subscriptionId: number | null;
  addresses: string[];
  body: string;
  /** SMS only: the delivery report Android recorded. MMS delivery is never claimed. */
  deliveryReport: "none" | "pending" | "complete" | "failed" | null;
  attachments: number;
}
/** Why the host could not read a row completely. Such a row carries no content; open it in the system messaging app. */
export type SmsIncompleteReason =
  | "body-too-long"
  | "address-too-long"
  | "too-many-addresses"
  | "address-unavailable"
  | "text-as-attachment"
  | "too-many-parts";
const INCOMPLETE_REASONS: readonly SmsIncompleteReason[] = [
  "body-too-long",
  "address-too-long",
  "too-many-addresses",
  "address-unavailable",
  "text-as-attachment",
  "too-many-parts",
];
/** A thread the host refused to clip. Its date keeps the page order and cursor. */
export interface IncompleteSmsThread {
  id: string;
  date: number;
  incomplete: true;
  reason: SmsIncompleteReason;
}
/** A message the host refused to clip. Its date keeps the page order and cursor. */
export interface IncompleteSmsMessage {
  id: string;
  kind: "sms" | "mms";
  threadId: string;
  date: number;
  incomplete: true;
  reason: SmsIncompleteReason;
}
export function isIncompleteSmsRow(
  row: SmsThread | IncompleteSmsThread | SmsMessage | IncompleteSmsMessage,
): row is IncompleteSmsThread | IncompleteSmsMessage {
  return "incomplete" in row && row.incomplete === true;
}
const incompleteReason = (value: unknown) => {
  if (!INCOMPLETE_REASONS.includes(value as SmsIncompleteReason))
    throw invalid("incomplete row reason");
  return value as SmsIncompleteReason;
};
export const SMS_MAX_THREADS = 50;
export const SMS_MAX_MESSAGES = 50;
const THREAD_ID = /^thread:[1-9]\d{0,17}$/;
const MESSAGE_ID = /^(sms|mms):[1-9]\d{0,17}$/;
const THREAD_CURSOR = /^\d{1,16}:thread:[1-9]\d{0,17}$/;
const MESSAGE_CURSOR = /^\d{1,16}:(sms|mms):[1-9]\d{0,17}$/;
const count = (value: unknown, what: string) => {
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    throw invalid(what);
  return value as number;
};
const addresses = (value: unknown) => {
  if (!Array.isArray(value) || value.length > 20)
    throw invalid("message addresses");
  return value.map((item) => text(item, "message address", 64));
};
export function parseThreads(
  value: unknown,
  limit: number,
): (SmsThread | IncompleteSmsThread)[] {
  const data = object(value, "threads");
  if (!Array.isArray(data.threads) || data.threads.length > limit)
    throw invalid("threads");
  const seen = new Set<string>();
  return data.threads.map((row) => {
    const t = object(row, "thread");
    const id = text(t.id, "thread id", 32);
    if (!THREAD_ID.test(id) || seen.has(id)) throw invalid("thread id");
    seen.add(id);
    if (t.incomplete !== undefined) {
      if (t.incomplete !== true || Object.keys(t).length !== 4)
        throw invalid("incomplete thread");
      return {
        id,
        date: count(t.date, "thread date"),
        incomplete: true,
        reason: incompleteReason(t.reason),
      };
    }
    return {
      id,
      date: count(t.date, "thread date"),
      messageCount: count(t.messageCount, "thread count"),
      snippet: text(t.snippet, "thread snippet", 160),
      unread: bool(t.unread, "thread"),
      addresses: addresses(t.addresses),
    };
  });
}
const INCOMING: readonly MessageStatus[] = ["received", "read"];
const OUTGOING: readonly MessageStatus[] = [
  "pending",
  "sent",
  "failed",
  "delivered",
];
const REPORTS = ["none", "pending", "complete", "failed"] as const;
export function parseMessages(
  value: unknown,
  threadId: string,
  limit: number,
): (SmsMessage | IncompleteSmsMessage)[] {
  const data = object(value, "messages");
  if (!Array.isArray(data.messages) || data.messages.length > limit)
    throw invalid("messages");
  const seen = new Set<string>();
  return data.messages.map((row) => {
    const m = object(row, "message");
    const id = text(m.id, "message id", 32);
    const kind = m.kind;
    const direction = m.direction;
    const status = m.status as MessageStatus;
    if (
      !MESSAGE_ID.test(id) ||
      seen.has(id) ||
      !id.startsWith(`${kind}:`) ||
      m.threadId !== threadId
    )
      throw invalid("message id");
    seen.add(id);
    if (m.incomplete !== undefined) {
      if (m.incomplete !== true || Object.keys(m).length !== 6)
        throw invalid("incomplete message");
      return {
        id,
        kind: kind as "sms" | "mms",
        threadId,
        date: count(m.date, "message date"),
        incomplete: true,
        reason: incompleteReason(m.reason),
      };
    }
    if (direction !== "incoming" && direction !== "outgoing")
      throw invalid("message direction");
    if (!(direction === "incoming" ? INCOMING : OUTGOING).includes(status))
      throw invalid("message status");
    const report =
      m.deliveryReport === null
        ? null
        : (m.deliveryReport as SmsMessage["deliveryReport"]);
    // Delivery reports exist only for outgoing SMS, and "delivered" only with a complete one.
    if (
      report !== null &&
      (kind !== "sms" ||
        direction !== "outgoing" ||
        !REPORTS.includes(report as (typeof REPORTS)[number]))
    )
      throw invalid("delivery report");
    if (kind === "sms" && direction === "outgoing" && report === null)
      throw invalid("delivery report");
    if (status === "delivered" && report !== "complete")
      throw invalid("message status");
    const subscriptionId =
      m.subscriptionId === null
        ? null
        : count(m.subscriptionId, "message subscription");
    return {
      id,
      kind: kind as "sms" | "mms",
      threadId,
      direction,
      status,
      date: count(m.date, "message date"),
      read: bool(m.read, "message"),
      subscriptionId,
      addresses: addresses(m.addresses),
      body: text(m.body, "message body", 2000),
      deliveryReport: report,
      attachments: count(m.attachments, "attachments"),
    };
  });
}

const OPERATION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const operation = (
  review: SmsReview & { subscriptionId: number },
): SmsSendOperation => ({
  type: "sms_send",
  recipients: review.recipients,
  body: review.body,
  subscriptionId: review.subscriptionId,
});
/** The shared contract's binding text: fixed field order, hashed as UTF-8 SHA-256 by the native journal. */
export function smsBindingText(
  review: SmsReview & { subscriptionId: number },
): string {
  return contractBindingText(operation(review));
}
export async function smsBindingHash(
  review: SmsReview & { subscriptionId: number },
): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(smsBindingText(review)),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
/** A native result bound to exactly the reviewed content (the shared `validateSmsResult`). */
export function parseSmsSendResult(
  value: unknown,
  review: SmsReview & { subscriptionId: number },
  operationId: string,
  bindingHash: string,
): SmsSendResult {
  return validateSmsResult(operation(review), value, operationId, bindingHash);
}
/** Display-only journal metadata. Never use this in place of a request-bound action receipt. */
export function parseSmsJournal(value: unknown): SmsSendResult[] {
  const data = object(value, "SMS journal");
  if (!Array.isArray(data.receipts) || data.receipts.length > 200)
    throw invalid("SMS journal");
  const seen = new Set<string>();
  return data.receipts.map((raw) => {
    const row = object(raw, "SMS journal receipt");
    if (
      typeof row.operationId !== "string" ||
      seen.has(row.operationId) ||
      !Number.isSafeInteger(row.subscriptionId) ||
      (row.subscriptionId as number) < 0 ||
      typeof row.bindingHash !== "string" ||
      !Array.isArray(row.parts)
    )
      throw invalid("SMS journal receipt");
    seen.add(row.operationId);
    let recipients = 1;
    for (const rawPart of row.parts) {
      const part = object(rawPart, "SMS journal part");
      if (
        !Number.isInteger(part.recipientIndex) ||
        (part.recipientIndex as number) < 0 ||
        (part.recipientIndex as number) > 4
      )
        throw invalid("SMS journal recipient");
      recipients = Math.max(recipients, (part.recipientIndex as number) + 1);
    }
    return validateSmsResult(
      {
        type: "sms_send",
        recipients: Array(recipients).fill("display-only"),
        body: "",
        subscriptionId: row.subscriptionId as number,
      },
      row,
      row.operationId,
      row.bindingHash,
    );
  });
}
/** No send result permits an automatic repeat: only a new owner review with a new operation ID. */
export function smsSendMayRetryAutomatically(_: SmsSendResult): false {
  return false;
}

const VOICEMAIL_METHODS = [
  "voicemailStatus",
  "listVoicemail",
  "fetchVoicemailAudio",
  "voicemailAudio",
  "voicemailPcm",
  "markVoicemailHeard",
  "deleteVoicemail",
  "observeVoicemail",
] as const;
type VoicemailMethod = (typeof VOICEMAIL_METHODS)[number];
/** The renderer client. Without the admitted profile every method rejects without reaching native code. */
export function createTelephonyClient(
  plugin: TelephonyNativePlugin | null,
  admitted: boolean,
  options: { unavailableMessage?: string } = {},
) {
  const native = () => {
    if (!admitted || !plugin)
      throw new TelephonyUnavailable(options.unavailableMessage);
    return plugin;
  };
  /** The bridge of a host whose native side has every voicemail method; older hosts have none. */
  const voicemail = () => {
    const bridge = native();
    if (!VOICEMAIL_METHODS.every((method) => bridge[method]))
      throw new TelephonyUnavailable(
        "Voicemail is not available in this install.",
      );
    return bridge as TelephonyNativePlugin &
      Required<Pick<TelephonyNativePlugin, VoicemailMethod>>;
  };
  const voicemailId = (id: string) => {
    if (typeof id !== "string" || !VOICEMAIL_ID.test(id))
      throw new RangeError("Invalid voicemail");
    return id;
  };
  return {
    available: admitted && !!plugin,
    async imageCapability() {
      return parseImageCapability(await native().imageCapability());
    },
    async status() {
      return parseTelephonyStatus(await native().status());
    },
    async requestAccess(access: TelephonyAccessKind) {
      return parseTelephonyStatus(await native().requestAccess({ access }));
    },
    async requestRole(role: TelephonyRole) {
      return parseTelephonyStatus(await native().requestRole({ role }));
    },
    async searchContacts(query: string, limit = 25) {
      const bridge = native();
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
        throw new RangeError("Contact search limit must be 1 to 100");
      return parseContacts(
        await bridge.searchContacts({
          query: String(query).slice(0, 128),
          limit,
        }),
        limit,
      );
    },
    /** Recent calls, newest first, read only while the host is unlocked and in front. With `number`
     * the host filters in its query, so the page holds only that number's calls. An install
     * without recent-call access rejects as unavailable; it never answers with an empty list. */
    async recentCalls(limit = 25, number?: string) {
      const bridge = native();
      if (
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > TELEPHONY_CALL_LOG_MAX
      )
        throw new RangeError("Recent-calls limit must be 1 to 50");
      const filter =
        number === undefined ? undefined : normalizePhoneNumber(number);
      if (filter === null) throw new RangeError("Not a dialable phone number");
      if (!bridge.listRecentCalls)
        throw new TelephonyUnavailable(
          "Recent calls are not available in this install.",
        );
      return parseCallLog(
        await bridge.listRecentCalls(
          filter === undefined ? { limit } : { limit, number: filter },
        ),
        limit,
      );
    },
    /** Opens the user's dialer with the number filled in. The person places the call there; the
     * system dialer also handles emergency numbers. */
    async dial(number: string) {
      const bridge = native();
      const normalized = normalizePhoneNumber(number);
      if (!normalized) throw new RangeError("Not a dialable phone number");
      return parseHandoff(await bridge.dial({ number: normalized }), "dialer");
    },
    /**
     * Places a call the owner asked for, through Android's Telecom, while this app is the default
     * phone app. `placed` means only that Android accepted the request. An emergency number is never
     * placed here: the dial screen opens with it (`emergency-handoff`). Rejects with code
     * `role-required` or `permission-required` when this app may not place calls.
     */
    async placeCall(number: string) {
      const bridge = native();
      const normalized = normalizePhoneNumber(number);
      if (!normalized) throw new RangeError("Not a dialable phone number");
      if (!bridge.placeCall)
        throw new TelephonyUnavailable(
          "Placing calls is not available in this install.",
        );
      return parsePlaceCall(await bridge.placeCall({ number: normalized }));
    },
    /** The phone's SIM lines for a Settings page, read only while the host is unlocked and in
     * front. `access` says which parts Android let the host read; a part it refused is null. */
    async phoneInfo() {
      const bridge = native();
      if (!bridge.phoneInfo)
        throw new TelephonyUnavailable(
          "Phone information is not available in this install.",
        );
      return parsePhoneInfo(await bridge.phoneInfo());
    },
    /** Whether this app may read voicemail and what the phone's voicemail sources report. */
    async voicemailStatus() {
      return parseVoicemailStatus(await voicemail().voicemailStatus());
    },
    /** Stored voicemails, newest first, with the carrier state they were read under. An
     * unsupported carrier is an empty list with `state: "unsupported"`, never an error. */
    async listVoicemail(limit = 25) {
      const bridge = voicemail();
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > VOICEMAIL_MAX)
        throw new RangeError("Voicemail limit must be 1 to 50");
      return parseVoicemailList(await bridge.listVoicemail({ limit }), limit);
    },
    /** `ready` when the audio is on the phone; otherwise asks its source to download it. */
    async fetchVoicemailAudio(id: string) {
      const bridge = voicemail();
      return parseVoicemailFetch(
        await bridge.fetchVoicemailAudio({ id: voicemailId(id) }),
      );
    },
    /** The stored audio bytes for playback, at most 8 MiB. */
    async voicemailAudio(id: string) {
      const bridge = voicemail();
      return parseVoicemailAudio(
        await bridge.voicemailAudio({ id: voicemailId(id) }),
        id,
      );
    },
    /** The voicemail decoded on the phone to a 16 kHz mono PCM16 WAV for on-device transcription;
     * audio over five minutes is refused. */
    async voicemailPcm(id: string) {
      const bridge = voicemail();
      return parseVoicemailPcm(
        await bridge.voicemailPcm({ id: voicemailId(id) }),
      );
    },
    async markVoicemailHeard(id: string) {
      const bridge = voicemail();
      return parseVoicemailWrite(
        await bridge.markVoicemailHeard({ id: voicemailId(id) }),
        "marked",
      );
    },
    /** Deletes one voicemail the owner chose from the phone's store. */
    async deleteVoicemail(id: string) {
      const bridge = voicemail();
      return parseVoicemailWrite(
        await bridge.deleteVoicemail({ id: voicemailId(id) }),
        "deleted",
      );
    },
    /** Change notices carry no voicemail content; read the list again. Returns the stop function. */
    async observeVoicemail(onChange: () => void) {
      const bridge = voicemail();
      if (!bridge.addListener)
        throw new TelephonyUnavailable(options.unavailableMessage);
      const handle = await bridge.addListener("voicemailChanged", () =>
        onChange(),
      );
      try {
        await bridge.observeVoicemail({ enabled: true });
      } catch (error) {
        await handle.remove();
        throw error;
      }
      return async () => {
        await handle.remove();
        await bridge.observeVoicemail({ enabled: false });
      };
    },
    /** Opens the user's SMS app with the reviewed recipients and text. Sending happens there. */
    async composeSms(review: SmsReview) {
      const bridge = native();
      // The SMS app chooses or asks for the SIM; a handoff cannot honour a choice made here.
      if (review.subscriptionId !== null)
        throw new RangeError(
          "Choose the SIM in your messaging app; a handoff cannot select it",
        );
      return parseHandoff(
        await bridge.composeSms({
          recipients: review.recipients,
          body: review.body,
        }),
        "sms",
      );
    },
    async listThreads(limit = 20, before?: number) {
      const bridge = native();
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > SMS_MAX_THREADS)
        throw new RangeError("Thread limit must be 1 to 50");
      if (
        before !== undefined &&
        (!Number.isSafeInteger(before) || before <= 0)
      )
        throw new RangeError("Invalid page cursor");
      return parseThreads(
        await bridge.listThreads(
          before === undefined ? { limit } : { limit, before },
        ),
        limit,
      );
    },
    async listMessages(threadId: string, limit = 25, before?: number) {
      const bridge = native();
      if (!THREAD_ID.test(threadId)) throw new RangeError("Invalid thread");
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > SMS_MAX_MESSAGES)
        throw new RangeError("Message limit must be 1 to 50");
      if (
        before !== undefined &&
        (!Number.isSafeInteger(before) || before <= 0)
      )
        throw new RangeError("Invalid page cursor");
      return parseMessages(
        await bridge.listMessages(
          before === undefined
            ? { threadId, limit }
            : { threadId, limit, before },
        ),
        threadId,
        limit,
      );
    },
    async threadPage(cursor?: string) {
      const bridge = native();
      if (cursor !== undefined && !THREAD_CURSOR.test(cursor))
        throw new RangeError("Invalid thread cursor");
      const value = object(
        await bridge.listThreads({ limit: 50, ...(cursor ? { cursor } : {}) }),
        "thread page",
      );
      const rows = parseThreads(value, 50);
      const next = value.next;
      if (
        next !== null &&
        (typeof next !== "string" || !THREAD_CURSOR.test(next))
      )
        throw invalid("thread cursor");
      if (next && (!rows.length || next === cursor))
        throw invalid("thread progress");
      return { rows, next: next as string | null };
    },
    async messagePage(threadId: string, cursor?: string) {
      const bridge = native();
      if (
        !THREAD_ID.test(threadId) ||
        (cursor !== undefined && !MESSAGE_CURSOR.test(cursor))
      )
        throw new RangeError("Invalid message cursor");
      const value = object(
        await bridge.listMessages({
          threadId,
          limit: 50,
          ...(cursor ? { cursor } : {}),
        }),
        "message page",
      );
      const rows = parseMessages(value, threadId, 50);
      const next = value.next;
      if (
        next !== null &&
        (typeof next !== "string" || !MESSAGE_CURSOR.test(next))
      )
        throw invalid("message cursor");
      if (next && (!rows.length || next === cursor))
        throw invalid("message progress");
      return { rows, next: next as string | null };
    },
    /**
     * Change notices carry no message content; re-read a bounded page. SMS and MMS send records
     * report updates separately (`smsSendResult` and `mmsSendResult` read them). Returns the stop
     * function.
     */
    async observeMessages(
      onChange: () => void,
      onSendUpdated?: (operationId: string) => void,
      onMmsSendUpdated?: (operationId: string) => void,
    ) {
      const bridge = native();
      if (!bridge.addListener)
        throw new TelephonyUnavailable(options.unavailableMessage);
      const handles = [
        await bridge.addListener("messagesChanged", () => onChange()),
      ];
      const operation =
        (handler: (operationId: string) => void) => (data: unknown) => {
          const id = (data as { operationId?: unknown } | null)?.operationId;
          if (typeof id === "string" && OPERATION_ID.test(id)) handler(id);
        };
      try {
        if (onSendUpdated)
          handles.push(
            await bridge.addListener(
              "smsSendUpdated",
              operation(onSendUpdated),
            ),
          );
        if (onMmsSendUpdated)
          handles.push(
            await bridge.addListener(
              "mmsSendUpdated",
              operation(onMmsSendUpdated),
            ),
          );
      } catch (error) {
        for (const handle of handles) await handle.remove();
        throw error;
      }
      try {
        await bridge.observeMessages({ enabled: true });
      } catch (error) {
        for (const handle of handles) await handle.remove();
        throw error;
      }
      return async () => {
        for (const handle of handles) await handle.remove();
        await bridge.observeMessages({ enabled: false });
      };
    },
    /**
     * Marks a conversation the owner opened as read, up to the newest message shown
     * (`throughDate`, milliseconds), and removes its notice. Only the default SMS app may keep read
     * state, so elsewhere nothing changes: `defaultSmsApp` is false and `updated` is 0. Later
     * messages stay unread.
     */
    async markThreadRead(threadId: string, throughDate: number) {
      const bridge = native();
      if (!THREAD_ID.test(threadId)) throw new RangeError("Invalid thread");
      if (!Number.isSafeInteger(throughDate) || throughDate <= 0)
        throw new RangeError("Invalid read marker date");
      const value = object(
        await bridge.markThreadRead({ threadId, throughDate }),
        "read marker",
      );
      const defaultSmsApp = bool(value.defaultSmsApp, "read marker");
      const updated = count(value.updated, "read marker");
      if (!defaultSmsApp && updated !== 0) throw invalid("read marker");
      return { defaultSmsApp, updated };
    },
    /** A reviewed native send. The host's native dialog shows the exact content again before
     * anything is sent. Reusing an operation ID returns its record and never sends twice. */
    async sendSms(review: SmsReview, operationId: string) {
      const bridge = native();
      if (!OPERATION_ID.test(operationId))
        throw new RangeError("Invalid operation ID");
      if (
        review.subscriptionId === null ||
        !Number.isSafeInteger(review.subscriptionId)
      )
        throw new RangeError("A native send needs the reviewed SIM");
      if (
        review.recipients.length > SMS_DIRECT_MAX_RECIPIENTS ||
        review.body.length > SMS_DIRECT_MAX_BODY
      )
        throw new RangeError("Too large for a native send");
      const bound = { ...review, subscriptionId: review.subscriptionId };
      const hash = await smsBindingHash(bound);
      const value = await bridge.sendSms({
        operationId,
        recipients: review.recipients,
        body: review.body,
        subscriptionId: review.subscriptionId,
      });
      const v = value as Record<string, unknown> | null;
      if (v && typeof v === "object" && v.kind === "sms-send-not-attempted") {
        if (
          Object.keys(v).length !== 3 ||
          v.operationId !== operationId ||
          (v.reason !== "busy" && v.reason !== "closed")
        )
          throw invalid("send result");
        throw new SmsSendNotAttempted(operationId, v.reason);
      }
      return parseSmsSendResult(value, bound, operationId, hash);
    },
    /** A reviewed native MMS: one message to every recipient, with the text and attachments the
     * host's native dialog shows again. Reusing an operation ID returns its record and never sends
     * twice. MMS delivery is never claimed; "sent" is the carrier's send confirmation. */
    async sendMms(review: MmsReview, operationId: string) {
      const bridge = native();
      if (!bridge.sendMms)
        throw new TelephonyUnavailable(
          "This phone cannot send MMS from Messages.",
        );
      if (!OPERATION_ID.test(operationId))
        throw new RangeError("Invalid operation ID");
      const { operation: bound, hash } = await mmsBinding(review);
      return validateMmsResult(
        bound,
        await bridge.sendMms({
          operationId,
          recipients: bound.recipients,
          body: bound.body,
          attachments: bound.attachments.map((a, index) => ({
            ...a,
            data: base64(review.attachments[index].bytes),
          })),
          subscriptionId: bound.subscriptionId,
        }),
        operationId,
        hash,
      );
    },
    /** Reads the journaled MMS result; never sends. */
    async mmsSendResult(review: MmsReview, operationId: string) {
      const bridge = native();
      if (!bridge.mmsSendResult)
        throw new TelephonyUnavailable(
          "This phone cannot send MMS from Messages.",
        );
      if (!OPERATION_ID.test(operationId))
        throw new RangeError("Invalid operation ID");
      const { operation: bound, hash } = await mmsBinding(review);
      return validateMmsResult(
        bound,
        await bridge.mmsSendResult({ operationId }),
        operationId,
        hash,
      );
    },
    /** Cancels only this operation's outstanding native review dialog. */
    async cancelSmsReview(operationId: string) {
      const bridge = native();
      if (!OPERATION_ID.test(operationId))
        throw new RangeError("Invalid operation ID");
      await bridge.cancelSmsReview({ operationId });
    },
    async smsSendHistory() {
      return parseSmsJournal(await native().smsSendHistory());
    },
    /** Reads the journaled result; never sends. */
    async smsSendResult(
      review: SmsReview & { subscriptionId: number },
      operationId: string,
    ) {
      const bridge = native();
      if (!OPERATION_ID.test(operationId))
        throw new RangeError("Invalid operation ID");
      return parseSmsSendResult(
        await bridge.smsSendResult({ operationId }),
        review,
        operationId,
        await smsBindingHash(review),
      );
    },
  };
}
export type TelephonyClient = ReturnType<typeof createTelephonyClient>;

const PROFILE_SLOT = Symbol.for("elizaos.native-telephony.profile");
type ProfileHolder = { [PROFILE_SLOT]?: TelephonyClient | null };

/**
 * Registers (or with `null` clears) the host's admitted telephony client, so the shared Messages,
 * Phone and Contacts surfaces route their side effects through its reviewed native screens. An
 * unavailable client is never kept. The slot is a `Symbol.for` global because view bundles load as
 * separate module instances. Returns a function that clears this registration only.
 */
export function registerTelephonyProfile(
  client: TelephonyClient | null,
): () => void {
  const holder = globalThis as ProfileHolder;
  const next = client?.available ? client : null;
  holder[PROFILE_SLOT] = next;
  return () => {
    if (holder[PROFILE_SLOT] === next) holder[PROFILE_SLOT] = null;
  };
}

/** The registered, admitted telephony client, or `null` (every install without the profile). */
export function telephonyProfile(): TelephonyClient | null {
  const client = (globalThis as ProfileHolder)[PROFILE_SLOT];
  return client?.available ? client : null;
}
