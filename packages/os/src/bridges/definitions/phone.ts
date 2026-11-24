// spec/os/android/phone.md, "Story: Hand an approved number to my phone"; spec/os/android/phone.md, "Story: Read my recent calls"; spec/os/android/voicemail.md, "Story: See my voicemail only when my carrier offers it"; spec/os/android/voicemail.md, "Story: Hear a voicemail"; spec/os/android/voicemail.md, "A delete waits in the deletion window, and its row is hidden only while it is queued"; spec/os/android/bridge.md, "Story: Admit a bridge call only with current evidence"
import type { Receipt } from "../../../gen/core__receipts.ts";
import type { Admission, ReadKind, WriteGate, WriteOutcome } from "../../../gen/os__android__bridge.ts";
import type { PageCursor } from "../../../gen/os__android__paging.ts";
import type { DialStatus, PlaceStatus } from "../../../gen/os__android__phone.ts";
import type { AudioCustody, CarrierState, PcmRefusal } from "../../../gen/os__android__voicemail.ts";
import type { StagedDeletion } from "./action-journal.ts";

export type PhoneNumber = string & { readonly __brand: "PhoneNumber" };
export type VoicemailId = string & { readonly __brand: "VoicemailId" };

export type TelephonyPermissionState = "granted" | "denied" | "prompt" | "prompt-with-rationale";
export type TelephonyRole = "dialer" | "sms";
export type TelephonyAccessKind = "contacts" | "phoneState" | "sms" | "sendSms" | "callLog";

export interface TelephonyRoleState {
  available: boolean;
  held: boolean;
  eligible: boolean;
}

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
    callLog?: TelephonyPermissionState;
  };
  sendMode: "direct" | "handoff";
  mmsSend: boolean;
  roles: Record<TelephonyRole, TelephonyRoleState>;
  defaultDialer: string | null;
  defaultSms: string | null;
  subscriptions: TelephonySubscription[] | null;
  defaultSmsSubscriptionId: number | null;
}

export interface ImageCapability {
  version: 1;
  image: true;
  feature: string;
}

export type TelephonyCallType =
  | "incoming"
  | "outgoing"
  | "missed"
  | "voicemail"
  | "rejected"
  | "blocked"
  | "answered_externally"
  | "unknown";

export interface TelephonyCallLogEntry {
  id: string;
  number: string;
  cachedName: string | null;
  date: number;
  durationSeconds: number;
  type: TelephonyCallType;
  isNew: boolean;
}

export interface RecentCallsAsk {
  limit?: number;
  number?: string;
  after?: PageCursor;
}

export interface RecentCallsPage {
  calls: TelephonyCallLogEntry[];
  next: PageCursor | null;
}

export type RecentCallsRefusal =
  | { tag: "CallLogUnavailable" }
  | { tag: "CallLogNotAdmitted"; admission: Admission }
  | { tag: "CallLogLimitRefused" }
  | { tag: "CallLogCursorRefused" }
  | { tag: "CallLogUnreadable" }
  | { tag: "CallLogStale" };

export type TelephonyHandoffStatus = "handed-off" | "unavailable" | "cancelled" | "failed";

export interface TelephonyHandoffResult {
  status: TelephonyHandoffStatus;
  target: "dialer" | "sms";
  handler: string | null;
  message: string;
}

export interface DialReport {
  dialStatus: DialStatus;
  handler: string | null;
  receipt: Receipt;
}

export type PlaceCallStatus = "placed" | "emergency-handoff" | "busy" | "unavailable" | "failed";

export interface PlaceCallResult {
  status: PlaceCallStatus;
  message: string;
}

export interface PlaceReport {
  placeStatus: PlaceStatus;
  receipt: Receipt;
}

export type PhoneNetworkType = "none" | "2g" | "3g" | "4g" | "5g" | "wifi-calling" | "unknown";

export interface PhoneLine {
  subscriptionId: number;
  slot: number;
  displayName: string;
  carrierName: string;
  number: string | null;
  countryIso: string | null;
  networkType: PhoneNetworkType;
  roaming: boolean | null;
  signalLevel: number | null;
  embedded: boolean;
  iccid: string | null;
  imei: string | null;
}

export interface PhoneInfo {
  access: { phoneState: boolean; phoneNumbers: boolean; deviceIdentifiers: boolean };
  lines: PhoneLine[];
}

export type VoicemailCarrierState = "ready" | "unconfigured" | "unsupported";

export interface VoicemailStatus {
  access: boolean;
  state: VoicemailCarrierState | null;
}

export interface VoicemailEntry {
  id: VoicemailId;
  number: string;
  cachedName: string | null;
  date: number;
  durationSeconds: number;
  isNew: boolean;
  hasAudio: boolean;
  carrierTranscript: string | null;
}

export interface VoicemailList {
  state: VoicemailCarrierState;
  voicemails: VoicemailEntry[];
}

export interface ListedVoicemail extends Omit<VoicemailEntry, "isNew" | "hasAudio"> {
  heard: boolean;
  audio: AudioCustody;
}

export interface VoicemailListing {
  carrier: CarrierState;
  gate: WriteGate;
  voicemails: ListedVoicemail[];
}

export type VoicemailFetchStatus = "ready" | "fetching" | "failed";

export interface VoicemailAudio {
  id: VoicemailId;
  mimeType: string;
  size: number;
  data: string;
}

export interface VoicemailPcm {
  mimeType: "audio/wav";
  sampleRateHz: 16000;
  durationSeconds: number;
  data: string;
}

export type VoicemailWriteStatus = "marked" | "unconfirmed" | "not-found";

export type VoicemailDeletionReport =
  | { status: "queued"; deletion: StagedDeletion; listing: VoicemailListing }
  | { status: "not-found"; listing: VoicemailListing };

export interface VoicemailWriteReport {
  written: WriteOutcome;
  receipt: Receipt;
  listing: VoicemailListing;
}

export type VoicemailRefusalReason = "not-admitted" | "unknown-voicemail" | "audio-already-asked" | "audio-not-on-phone" | "write-blocked";

export type { PcmRefusal };

export interface PhoneNativePlugin {
  imageCapability(): Promise<unknown>;
  status(): Promise<unknown>;
  requestAccess(options: { access: TelephonyAccessKind }): Promise<unknown>;
  requestRole(options: { role: TelephonyRole }): Promise<unknown>;
  listRecentCalls(options: { limit: number; number?: string; beforeDate?: number; beforeId?: number }): Promise<unknown>;
  dial(options: { number: string }): Promise<unknown>;
  placeCall(options: { number: string }): Promise<unknown>;
  phoneInfo(): Promise<unknown>;
  voicemailStatus(): Promise<unknown>;
  listVoicemail(options: { limit: number }): Promise<unknown>;
  fetchVoicemailAudio(options: { id: string }): Promise<unknown>;
  voicemailAudio(options: { id: string }): Promise<unknown>;
  voicemailPcm(options: { id: string }): Promise<unknown>;
  markVoicemailHeard(options: { id: string }): Promise<unknown>;
  deleteVoicemail(options: { id: string }): Promise<unknown>;
  observeVoicemail(options: { enabled: boolean }): Promise<unknown>;
  addListener(event: "voicemailChanged", listener: (data: unknown) => void): Promise<{ remove(): Promise<void> }>;
}

export interface PhoneClient {
  imageCapability(): Promise<ImageCapability>;
  status(): Promise<TelephonyStatus>;
  requestAccess(access: TelephonyAccessKind): Promise<TelephonyStatus>;
  requestRole(role: TelephonyRole): Promise<TelephonyStatus>;
  recentCalls(ask?: RecentCallsAsk): Promise<RecentCallsPage>;
  dial(number: string): Promise<DialReport>;
  placeCall(number: string): Promise<PlaceReport>;
  phoneInfo(): Promise<PhoneInfo>;
  voicemail(): Promise<VoicemailListing>;
  refreshVoicemail(kind?: ReadKind): Promise<VoicemailListing>;
  fetchVoicemailAudio(id: VoicemailId): Promise<VoicemailFetchStatus>;
  voicemailAudio(id: VoicemailId): Promise<VoicemailAudio>;
  voicemailPcm(id: VoicemailId): Promise<VoicemailPcm>;
  markVoicemailHeard(id: VoicemailId): Promise<VoicemailWriteReport>;
  deleteVoicemail(id: VoicemailId): Promise<VoicemailDeletionReport>;
  observeVoicemail(onChange: (refreshed: Promise<VoicemailListing>) => void): Promise<() => Promise<void>>;
}

export const TELEPHONY_PROFILE_METHOD = "imageCapability";
export const TELEPHONY_DEFAULT_PAGE = 25;
export const VOICEMAIL_AUDIO_MAX_BYTES = 8 * 1024 * 1024;
export const VOICEMAIL_PCM_RATE_HZ = 16000;
export const WAV_HEADER_BYTES = 44;
export const TELEPHONY_MAX_SUBSCRIPTIONS = 8;

const PERMISSIONS: readonly TelephonyPermissionState[] = ["granted", "denied", "prompt", "prompt-with-rationale"];
const ROLES: readonly TelephonyRole[] = ["dialer", "sms"];
const DIAL_SHAPE = /^\+?[\d\s().-]{2,40}$/;
const OPTIONAL_TRUNK_ZERO = /^(\+(?:41|44|49)) ?\(0\) ?(?=\d)/;
const DIGITS = /^\+?\d{2,20}$/;
const SEPARATORS = /[\s().-]/g;

type Fields = Record<string, unknown>;

function fields(value: unknown): Fields | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Fields) : undefined;
}

function text(value: unknown, max = 256): value is string {
  return typeof value === "string" && value.length <= max;
}

function nullableText(value: unknown): string | null | undefined {
  return value === null || value === undefined ? null : text(value) ? value : undefined;
}

function permission(value: unknown): TelephonyPermissionState | undefined {
  return PERMISSIONS.find((state) => state === value);
}

function count(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function role(value: unknown): TelephonyRoleState | undefined {
  const r = fields(value);
  if (!r || typeof r.available !== "boolean" || typeof r.held !== "boolean" || typeof r.eligible !== "boolean") return undefined;
  return r.held && !r.available ? undefined : { available: r.available, held: r.held, eligible: r.eligible };
}

function subscription(value: unknown): TelephonySubscription | undefined {
  const s = fields(value);
  if (!s || !count(s.id) || !count(s.slot) || !text(s.displayName) || !text(s.carrierName)) return undefined;
  if (typeof s.defaultSms !== "boolean" || typeof s.defaultVoice !== "boolean") return undefined;
  return { id: s.id, slot: s.slot, displayName: s.displayName, carrierName: s.carrierName, defaultSms: s.defaultSms, defaultVoice: s.defaultVoice };
}

function subscriptions(value: unknown, phoneState: TelephonyPermissionState): TelephonySubscription[] | null | undefined {
  if (value === null || value === undefined) return null;
  if (!Array.isArray(value) || value.length > TELEPHONY_MAX_SUBSCRIPTIONS || phoneState !== "granted") return undefined;
  const parsed = value.map(subscription);
  const ids = new Set(parsed.map((sim) => sim?.id));
  return parsed.every((sim) => sim !== undefined) && ids.size === parsed.length ? parsed : undefined;
}

/** @throws {never} */
export function detectTelephonyProfile(platform: string, headers: unknown, pluginName: string): boolean {
  if (platform !== "android" || !Array.isArray(headers)) return false;
  const methods = headers.map(fields).find((entry) => entry?.name === pluginName)?.methods;
  return Array.isArray(methods) && methods.some((method) => fields(method)?.name === TELEPHONY_PROFILE_METHOD);
}

/** @throws {never} */
export function parseImageCapability(value: unknown): ImageCapability | undefined {
  const data = fields(value);
  return data?.version === 1 && data.image === true && text(data.feature) ? { version: 1, image: true, feature: data.feature } : undefined;
}

/** @throws {never} */
export function parseTelephonyStatus(value: unknown): TelephonyStatus | undefined {
  const data = fields(value);
  const granted = fields(data?.permissions);
  const roles = fields(data?.roles);
  if (!data || !granted || !roles || data.version !== 2) return undefined;
  const contacts = permission(granted.contacts);
  const phoneState = permission(granted.phoneState);
  const sms = permission(granted.sms);
  const sendSms = permission(granted.sendSms);
  const callLog = granted.callLog === undefined ? undefined : permission(granted.callLog);
  const [dialer, smsRole] = ROLES.map((name) => role(roles[name]));
  if (!contacts || !phoneState || !sms || !sendSms || (granted.callLog !== undefined && !callLog) || !dialer || !smsRole) return undefined;
  if (typeof data.voiceCapable !== "boolean" || typeof data.smsCapable !== "boolean") return undefined;
  if (data.sendMode !== "direct" && data.sendMode !== "handoff") return undefined;
  if (data.sendMode === "direct" && (sendSms !== "granted" || phoneState !== "granted" || !data.smsCapable)) return undefined;
  const mmsSend = data.mmsSend ?? false;
  if (typeof mmsSend !== "boolean" || (mmsSend && data.sendMode !== "direct")) return undefined;
  const sims = subscriptions(data.subscriptions, phoneState);
  const defaultDialer = nullableText(data.defaultDialer);
  const defaultSms = nullableText(data.defaultSms);
  if (sims === undefined || defaultDialer === undefined || defaultSms === undefined) return undefined;
  const marked = sims?.filter((sim) => sim.defaultSms) ?? [];
  const chosen = data.defaultSmsSubscriptionId ?? null;
  if (chosen !== null && (marked.length !== 1 || marked[0]?.id !== chosen)) return undefined;
  return {
    version: 2,
    voiceCapable: data.voiceCapable,
    smsCapable: data.smsCapable,
    permissions: { contacts, phoneState, sms, sendSms, ...(callLog === undefined ? {} : { callLog }) },
    sendMode: data.sendMode,
    mmsSend,
    roles: { dialer, sms: smsRole },
    defaultDialer,
    defaultSms,
    subscriptions: sims,
    defaultSmsSubscriptionId: chosen === null ? null : (marked[0]?.id ?? null),
  };
}

/** @throws {never} */
export function normalizePhoneNumber(value: unknown): PhoneNumber | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!DIAL_SHAPE.test(trimmed)) return null;
  const digits = trimmed.replace(OPTIONAL_TRUNK_ZERO, "$1").replace(SEPARATORS, "");
  return DIGITS.test(digits) ? (digits as PhoneNumber) : null;
}
