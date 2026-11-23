// spec/os/android/messages.md, "Story: Send only what I reviewed, once"; spec/os/android/messages.md, "A repeated operation ID answers its journal record and never sends again"; spec/os/android/messages.md, "A message's status is supported by the evidence of every part, and an interrupted send reads unknown"; spec/os/android/messages.md, "A send's provider row is written only by an approved dispatch, and an MMS only while the app holds the SMS role"; spec/os/android/messages.md, "A deletion removes only the selected settled row and confirms only a removal Android reported"; spec/os/android/messages.md, "A conversation deletion removes only its settled rows up to the newest one I saw"; spec/os/android/messages.md, "A sender lookup reads only the newest incoming row's address, and names it whole only when asked"
import type { Receipt } from "../../../gen/core__receipts.ts";
import type { HandoffOutcome } from "../../../gen/os__android__bridge.ts";
import type { CallEvidence, DeleteStatus, PartEvidence, PartState, SendAnswer } from "../../../gen/os__android__messages.ts";
import { evidenceStatus, maxPartsPerRecipient, senderNumberAdmitted, senderSuffixDigits } from "../../../gen/os__android__messages.ts";
import type { StagedDeletion } from "./action-journal.ts";
import { normalizePhoneNumber, type PhoneNumber, type TelephonyStatus } from "./phone.ts";

export type OperationId = string & { readonly __brand: "OperationId" };
export type ThreadId = string & { readonly __brand: "ThreadId" };
export type MessageId = string & { readonly __brand: "MessageId" };
export type ThreadCursor = string & { readonly __brand: "ThreadCursor" };
export type MessageCursor = string & { readonly __brand: "MessageCursor" };

export interface SmsReview {
  recipients: PhoneNumber[];
  body: string;
  subscriptionId: number | null;
}

export type DirectSmsReview = SmsReview & { subscriptionId: number };

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

export const MMS_ATTACHMENT_TYPES = ["image/jpeg", "image/png", "image/gif"] as const;
export type MmsAttachmentType = (typeof MMS_ATTACHMENT_TYPES)[number];

export interface MmsAttachmentDraft {
  contentType: string;
  name: string;
  bytes: Uint8Array;
}

export interface MmsReview {
  recipients: PhoneNumber[];
  body: string;
  attachments: { contentType: MmsAttachmentType; name: string; bytes: Uint8Array }[];
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

export interface MmsAttachmentBinding {
  contentType: MmsAttachmentType;
  name: string;
  sha256: string;
  size: number;
}

export interface MmsBinding {
  recipients: PhoneNumber[];
  body: string;
  attachments: MmsAttachmentBinding[];
  subscriptionId: number;
}

export type SmsSendState = "reviewed" | "handed-off" | "dispatched" | "sent" | "delivered" | "failed" | "outcome-unknown";

export type SendPartState = "unknown" | "success" | "failed";

export interface SmsSendPart {
  index: number;
  recipientIndex: number;
  partIndex: number;
  sent: SendPartState;
  delivery: SendPartState;
}

export type SmsSendStatus = "cancelled" | "denied" | "failed" | "unknown" | "submitted" | "sent" | "delivered";
export type MmsSendStatus = Exclude<SmsSendStatus, "delivered">;

export interface SmsSendResult {
  kind: "sms-send";
  operationId: OperationId;
  subscriptionId: number;
  bindingHash: string;
  status: SmsSendStatus;
  parts: SmsSendPart[];
  createdAt: number;
}

export interface MmsSendResult {
  kind: "mms-send";
  operationId: OperationId;
  subscriptionId: number;
  bindingHash: string;
  status: MmsSendStatus;
  createdAt: number;
}

export type SendNotAttemptedReason = "busy" | "closed";
export type SmsCancelOutcome = "cancelled" | "refused";

export type MessageDirection = "incoming" | "outgoing";
export type MessageStatus = "received" | "read" | "pending" | "sent" | "failed" | "delivered";
export type DeliveryReport = "none" | "pending" | "complete" | "failed";
export type MessageKind = "sms" | "mms";

export interface SmsThread {
  id: ThreadId;
  date: number;
  messageCount: number;
  snippet: string;
  unread: boolean;
  addresses: string[];
}

export interface SmsMessage {
  id: MessageId;
  kind: MessageKind;
  threadId: ThreadId;
  direction: MessageDirection;
  status: MessageStatus;
  date: number;
  read: boolean;
  subscriptionId: number | null;
  addresses: string[];
  body: string;
  deliveryReport: DeliveryReport | null;
  attachments: number;
}

export const SMS_INCOMPLETE_REASONS = [
  "body-too-long",
  "address-too-long",
  "too-many-addresses",
  "address-unavailable",
  "text-as-attachment",
  "too-many-parts",
] as const;
export type SmsIncompleteReason = (typeof SMS_INCOMPLETE_REASONS)[number];

export interface IncompleteSmsThread {
  id: ThreadId;
  date: number;
  incomplete: true;
  reason: SmsIncompleteReason;
}

export interface IncompleteSmsMessage {
  id: MessageId;
  kind: MessageKind;
  threadId: ThreadId;
  date: number;
  incomplete: true;
  reason: SmsIncompleteReason;
}

export type ThreadRow = SmsThread | IncompleteSmsThread;
export type MessageRow = SmsMessage | IncompleteSmsMessage;

export interface ThreadPage {
  rows: ThreadRow[];
  next: ThreadCursor | null;
}

export interface MessagePage {
  rows: MessageRow[];
  next: MessageCursor | null;
}

export interface MessageDeleteReference {
  id: MessageId;
  kind: MessageKind;
  threadId: ThreadId;
  date: number;
}

export type MessageDeleteStatus = "queued" | "not-found" | "stale" | "not-settled";

export type MessageDeleteResult =
  | { status: "queued"; deleteStatus: DeleteStatus; message: MessageDeleteReference; deletion: StagedDeletion }
  | { status: Exclude<MessageDeleteStatus, "queued">; deleteStatus: DeleteStatus; message: MessageDeleteReference };

export interface ThreadDeleteReference {
  threadId: ThreadId;
  through: number;
}

export type ThreadDeleteStatus = "queued" | "not-found" | "not-settled";

export type ThreadDeleteResult =
  | { status: "queued"; deleteStatus: DeleteStatus; thread: ThreadDeleteReference; deletion: StagedDeletion }
  | { status: Exclude<ThreadDeleteStatus, "queued">; deleteStatus: DeleteStatus; thread: ThreadDeleteReference };

export interface StagingAnswer<Status, Reference> {
  status: Status;
  deleteStatus: DeleteStatus;
  reference: Reference;
  deletion: unknown;
}

export type SmsLatestSender =
  | { status: "found"; numberEnding: string }
  | { status: "found"; address: PhoneNumber; threadId?: ThreadId }
  | { status: "empty" | "sender-unavailable" };

export interface ThreadReadMark {
  defaultSmsApp: boolean;
  updated: number;
}

export interface SmsHandoffReport {
  outcome: HandoffOutcome;
  handler: string | null;
  message: string;
  receipt: Receipt;
}

export interface MessagesNativePlugin {
  status(): Promise<unknown>;
  composeSms(options: { recipients: string[]; body: string }): Promise<unknown>;
  listThreads(options: { limit: number; before?: number; cursor?: string }): Promise<unknown>;
  listMessages(options: { threadId: string; limit: number; before?: number; cursor?: string }): Promise<unknown>;
  latestIncomingSender(options?: { includeAddress: true }): Promise<unknown>;
  markThreadRead(options: { threadId: string; throughDate: number }): Promise<unknown>;
  deleteMessage(options: MessageDeleteReference): Promise<unknown>;
  deleteThread(options: ThreadDeleteReference): Promise<unknown>;
  observeMessages(options: { enabled: boolean }): Promise<unknown>;
  sendSms(options: { operationId: string; recipients: string[]; body: string; subscriptionId: number }): Promise<unknown>;
  sendMms(options: {
    operationId: string;
    recipients: string[];
    body: string;
    attachments: (MmsAttachmentBinding & { data: string })[];
    subscriptionId: number;
  }): Promise<unknown>;
  cancelSmsReview(options: { operationId: string }): Promise<unknown>;
  smsSendHistory(): Promise<unknown>;
  smsSendResult(options: { operationId: string }): Promise<unknown>;
  mmsSendResult(options: { operationId: string }): Promise<unknown>;
  addListener(
    event: "messagesChanged" | "smsSendUpdated" | "mmsSendUpdated",
    listener: (data: unknown) => void,
  ): Promise<{ remove(): Promise<void> }>;
}

export interface MessagesClient {
  status(): Promise<TelephonyStatus>;
  composeSms(review: SmsReview): Promise<SmsHandoffReport>;
  listThreads(limit?: number, before?: number): Promise<ThreadRow[]>;
  listMessages(threadId: ThreadId, limit?: number, before?: number): Promise<MessageRow[]>;
  threadPage(cursor?: ThreadCursor): Promise<ThreadPage>;
  messagePage(threadId: ThreadId, cursor?: MessageCursor): Promise<MessagePage>;
  latestIncomingSender(includeAddress?: boolean): Promise<SmsLatestSender>;
  markThreadRead(threadId: ThreadId, throughDate: number): Promise<ThreadReadMark>;
  deleteMessage(reference: MessageDeleteReference): Promise<MessageDeleteResult>;
  deleteThread(reference: ThreadDeleteReference): Promise<ThreadDeleteResult>;
  observeMessages(
    onChange: () => void,
    onSendUpdated?: (operationId: OperationId) => void,
    onMmsSendUpdated?: (operationId: OperationId) => void,
  ): Promise<() => Promise<void>>;
  sendSms(review: DirectSmsReview, operationId: OperationId): Promise<SmsSendResult>;
  sendMms(review: MmsReview, operationId: OperationId): Promise<MmsSendResult>;
  cancelSmsReview(operationId: OperationId): Promise<SmsCancelOutcome>;
  smsSendHistory(): Promise<SmsSendResult[]>;
  smsSendResult(review: DirectSmsReview, operationId: OperationId): Promise<SmsSendResult>;
  mmsSendResult(review: MmsReview, operationId: OperationId): Promise<MmsSendResult>;
}

export const SMS_MAX_RECIPIENTS = 10;
export const SMS_MAX_BODY = 5000;
export const SMS_DIRECT_MAX_RECIPIENTS = 5;
export const SMS_DIRECT_MAX_BODY = 1600;
export const MMS_MAX_RECIPIENTS = 10;
export const MMS_MAX_ATTACHMENTS = 5;
export const MMS_MAX_BODY = 1600;
export const MMS_MAX_TOTAL_BYTES = 1024 * 1024;
export const SMS_JOURNAL_MAX = 200;
export const SMS_MAX_PARTS = 50;

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;
const MMS_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const OPERATION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const HASH = /^[a-f0-9]{64}$/;
const THREAD_ID = /^thread:[1-9]\d{0,17}$/;
const MESSAGE_ID = /^(sms|mms):[1-9]\d{0,17}$/;
const THREAD_CURSOR = /^\d{1,16}:thread:[1-9]\d{0,17}$/;
const MESSAGE_CURSOR = /^\d{1,16}:(sms|mms):[1-9]\d{0,17}$/;
const PART_STATES: readonly SendPartState[] = ["unknown", "success", "failed"];
const SMS_STATUSES: readonly SmsSendStatus[] = ["cancelled", "denied", "failed", "unknown", "submitted", "sent", "delivered"];
const DELETE_STATUSES: readonly MessageDeleteStatus[] = ["queued", "not-found", "stale", "not-settled"];
const THREAD_DELETE_STATUSES: readonly ThreadDeleteStatus[] = ["queued", "not-found", "not-settled"];
const INCOMING: readonly MessageStatus[] = ["received", "read"];
const OUTGOING: readonly MessageStatus[] = ["pending", "sent", "failed", "delivered"];
const REPORTS: readonly DeliveryReport[] = ["none", "pending", "complete", "failed"];
const SMS_NEXT: Readonly<Record<SmsSendState, readonly SmsSendState[]>> = {
  reviewed: ["handed-off", "dispatched", "failed"],
  dispatched: ["sent", "failed", "outcome-unknown"],
  sent: ["delivered"],
  "handed-off": [],
  delivered: [],
  failed: [],
  "outcome-unknown": [],
};
const SEND_RECORD: Readonly<Record<SmsSendStatus, SendAnswer>> = {
  cancelled: "SendCancelled",
  denied: "SendDenied",
  failed: "SendFailed",
  unknown: "SendUnknown",
  submitted: "SendSubmitted",
  sent: "SendSent",
  delivered: "SendDelivered",
};
const PART_STATE: Readonly<Record<SendPartState, PartState>> = { unknown: "PartWaiting", success: "PartSucceeded", failed: "PartFailed" };
const DELETE_STATUS: Readonly<Record<MessageDeleteStatus, DeleteStatus>> = {
  queued: "DeleteQueued",
  "not-found": "MessageNotFound",
  stale: "MessageStale",
  "not-settled": "MessageNotSettled",
};

type Fields = Record<string, unknown>;

function fields(value: unknown, keys?: readonly string[]): Fields | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const data = value as Fields;
  return keys === undefined || (Object.keys(data).length === keys.length && keys.every((key) => Object.hasOwn(data, key))) ? data : undefined;
}

function text(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length <= max;
}

function count(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function moment(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function oneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return values.includes(value as T);
}

function recipientsOf(raw: unknown, max: number): PhoneNumber[] | SmsReviewProblem {
  if (!Array.isArray(raw) || raw.length === 0) return "no-recipient";
  if (raw.length > max) return "too-many-recipients";
  const recipients: PhoneNumber[] = [];
  for (const entry of raw) {
    const number = normalizePhoneNumber(entry);
    if (number === null) return "invalid-recipient";
    if (!recipients.includes(number)) recipients.push(number);
  }
  return recipients;
}

function simOf(subscriptionId: unknown, status: TelephonyStatus): number | SmsReviewProblem {
  const active = status.subscriptions;
  if (active === null) return "sim-unknown";
  if (subscriptionId !== undefined && subscriptionId !== null) {
    const chosen = active.find((sim) => sim.id === subscriptionId);
    return chosen === undefined ? "sim-unknown" : chosen.id;
  }
  const only = active[0];
  return active.length === 1 && only !== undefined ? only.id : active.length > 1 ? "sim-required" : "sim-unknown";
}

/** @throws {never} */
export function operationIdOf(value: unknown): OperationId | null {
  return typeof value === "string" && OPERATION_ID.test(value) ? (value as OperationId) : null;
}

/** @throws {never} */
export function threadIdOf(value: unknown): ThreadId | null {
  return typeof value === "string" && THREAD_ID.test(value) ? (value as ThreadId) : null;
}

/** @throws {never} */
export function threadCursorOf(value: unknown): ThreadCursor | null {
  return typeof value === "string" && THREAD_CURSOR.test(value) ? (value as ThreadCursor) : null;
}

/** @throws {never} */
export function messageCursorOf(value: unknown): MessageCursor | null {
  return typeof value === "string" && MESSAGE_CURSOR.test(value) ? (value as MessageCursor) : null;
}

/** @throws {never} */
export function reviewSms(
  draft: { recipients: unknown; body: unknown; subscriptionId?: unknown },
  status: TelephonyStatus,
  mode: "handoff" | "direct" = "handoff",
): { review: SmsReview } | { problem: SmsReviewProblem } {
  const direct = mode === "direct";
  const recipients = recipientsOf(draft.recipients, direct ? SMS_DIRECT_MAX_RECIPIENTS : SMS_MAX_RECIPIENTS);
  if (!Array.isArray(recipients)) return { problem: recipients };
  const body = draft.body;
  if (typeof body !== "string" || body.trim() === "") return { problem: "empty-body" };
  if (body.length > (direct ? SMS_DIRECT_MAX_BODY : SMS_MAX_BODY)) return { problem: "body-too-long" };
  if (direct && (body.includes("\0") || LONE_SURROGATE.test(body))) return { problem: "invalid-body" };
  const chosen = draft.subscriptionId !== undefined && draft.subscriptionId !== null;
  if (!direct) return chosen ? { problem: "sim-not-selectable" } : { review: { recipients, body, subscriptionId: null } };
  const subscriptionId = simOf(draft.subscriptionId, status);
  return typeof subscriptionId === "number" ? { review: { recipients, body, subscriptionId } } : { problem: subscriptionId };
}

/** @throws {never} */
export function reviewMms(
  draft: { recipients: unknown; body: unknown; attachments?: readonly MmsAttachmentDraft[]; subscriptionId?: unknown },
  status: TelephonyStatus,
): { review: MmsReview } | { problem: MmsReviewProblem } {
  if (status.sendMode !== "direct" || !status.mmsSend || !status.roles.sms.held) return { problem: "mms-unavailable" };
  const recipients = recipientsOf(draft.recipients, MMS_MAX_RECIPIENTS);
  if (!Array.isArray(recipients)) return { problem: recipients };
  const body = typeof draft.body === "string" ? draft.body : "";
  if (body.length > MMS_MAX_BODY) return { problem: "body-too-long" };
  if (body.includes("\0") || LONE_SURROGATE.test(body)) return { problem: "invalid-body" };
  const drafts = draft.attachments ?? [];
  if (drafts.length > MMS_MAX_ATTACHMENTS) return { problem: "too-many-attachments" };
  const attachments: MmsReview["attachments"] = [];
  for (const one of drafts) {
    if (!oneOf(MMS_ATTACHMENT_TYPES, one.contentType)) return { problem: "attachment-type" };
    if (!MMS_NAME.test(one.name) || attachments.some((other) => other.name === one.name)) return { problem: "attachment-name" };
    if (!(one.bytes instanceof Uint8Array) || one.bytes.length === 0) return { problem: "attachment-empty" };
    attachments.push({ contentType: one.contentType, name: one.name, bytes: one.bytes });
  }
  if (attachments.reduce((total, one) => total + one.bytes.length, 0) > MMS_MAX_TOTAL_BYTES) return { problem: "too-large" };
  if (body.trim() === "" && attachments.length === 0) return { problem: "empty-message" };
  const subscriptionId = simOf(draft.subscriptionId, status);
  return typeof subscriptionId === "number" ? { review: { recipients, body, attachments, subscriptionId } } : { problem: subscriptionId };
}

/** @throws {never} */
export function advanceSmsState(from: SmsSendState, to: SmsSendState): SmsSendState | undefined {
  return SMS_NEXT[from].includes(to) ? to : undefined;
}

/** @throws {never} */
export function smsMayBeReviewedAgain(state: SmsSendState): boolean {
  return state === "reviewed" || state === "failed";
}

/** @throws {never} */
export function smsBindingText(review: DirectSmsReview): string {
  return JSON.stringify({ body: review.body, recipients: review.recipients, subscriptionId: review.subscriptionId, type: "sms_send" });
}

/** @throws {never} */
export function mmsBindingText(binding: MmsBinding): string {
  return JSON.stringify({
    attachments: binding.attachments.map((one) => ({ contentType: one.contentType, name: one.name, sha256: one.sha256, size: one.size })),
    body: binding.body,
    recipients: binding.recipients,
    subscriptionId: binding.subscriptionId,
    type: "mms_send",
  });
}

function parts(raw: unknown, recipients: number): SmsSendPart[] | undefined {
  if (!Array.isArray(raw) || raw.length > SMS_MAX_PARTS) return undefined;
  const perRecipient = Array.from({ length: recipients }, () => 0);
  const out: SmsSendPart[] = [];
  for (const [index, entry] of raw.entries()) {
    const part = fields(entry, ["index", "recipientIndex", "partIndex", "sent", "delivery"]);
    const recipient = part?.recipientIndex;
    const previous = out.at(-1)?.recipientIndex ?? 0;
    if (!part || part.index !== index || !count(recipient) || recipient < previous || recipient > previous + 1 || recipient >= recipients) return undefined;
    if (part.partIndex !== perRecipient[recipient] || (perRecipient[recipient] ?? 0) >= maxPartsPerRecipient) return undefined;
    if (!oneOf(PART_STATES, part.sent) || !oneOf(PART_STATES, part.delivery)) return undefined;
    perRecipient[recipient] = (perRecipient[recipient] ?? 0) + 1;
    out.push({ index, recipientIndex: recipient, partIndex: part.partIndex, sent: part.sent, delivery: part.delivery });
  }
  return out;
}

function evidence(part: SmsSendPart): PartEvidence {
  return { sentState: PART_STATE[part.sent], deliveryState: PART_STATE[part.delivery] };
}

function supported(status: SmsSendStatus, sent: readonly SmsSendPart[], recipients: number): boolean {
  const record = SEND_RECORD[status];
  if (record === "SendCancelled" || record === "SendDenied") return sent.every((part) => part.sent === "unknown" && part.delivery === "unknown");
  const covered = sent.length > 0 && sent.at(-1)?.recipientIndex === recipients - 1;
  if (!covered && record !== "SendUnknown" && record !== "SendFailed") return false;
  const calls: CallEvidence = record === "SendSubmitted" ? "AllCallsReturned" : "ReceiptsLost";
  return evidenceStatus({ parts: sent.map(evidence), mms: false, calls }) === record;
}

/** @throws {never} */
export function partsPerRecipient(sent: readonly SmsSendPart[]): number {
  return Math.max(1, ...sent.map((part) => part.partIndex + 1));
}

function smsRecord(raw: unknown, recipients: number, operationId: OperationId, subscriptionId: number, bindingHash: string): SmsSendResult | undefined {
  const data = fields(raw, ["kind", "operationId", "subscriptionId", "bindingHash", "status", "parts", "createdAt"]);
  if (!data || data.kind !== "sms-send" || data.operationId !== operationId || data.subscriptionId !== subscriptionId || data.bindingHash !== bindingHash) return undefined;
  if (!HASH.test(bindingHash) || !oneOf(SMS_STATUSES, data.status) || !moment(data.createdAt)) return undefined;
  const evidenced = parts(data.parts, recipients);
  if (evidenced === undefined || !supported(data.status, evidenced, recipients)) return undefined;
  return { kind: "sms-send", operationId, subscriptionId, bindingHash, status: data.status, parts: evidenced, createdAt: data.createdAt };
}

/** @throws {never} */
export function parseSmsSendResult(value: unknown, review: DirectSmsReview, operationId: OperationId, bindingHash: string): SmsSendResult | undefined {
  return smsRecord(value, review.recipients.length, operationId, review.subscriptionId, bindingHash);
}

/** @throws {never} */
export function parseMmsSendResult(value: unknown, binding: MmsBinding, operationId: OperationId, bindingHash: string): MmsSendResult | undefined {
  const data = fields(value, ["kind", "operationId", "subscriptionId", "bindingHash", "status", "createdAt"]);
  if (!data || data.kind !== "mms-send" || data.operationId !== operationId || data.subscriptionId !== binding.subscriptionId || data.bindingHash !== bindingHash) return undefined;
  const status = data.status;
  if (!HASH.test(bindingHash) || !oneOf(SMS_STATUSES, status) || status === "delivered" || !moment(data.createdAt)) return undefined;
  return { kind: "mms-send", operationId, subscriptionId: binding.subscriptionId, bindingHash, status, createdAt: data.createdAt };
}

/** @throws {never} */
export function parseSmsJournal(value: unknown): SmsSendResult[] | undefined {
  const receipts = fields(value, ["receipts"])?.receipts;
  if (!Array.isArray(receipts) || receipts.length > SMS_JOURNAL_MAX) return undefined;
  const seen = new Set<string>();
  const out: SmsSendResult[] = [];
  for (const entry of receipts) {
    const row = fields(entry);
    const operationId = operationIdOf(row?.operationId);
    const rows = Array.isArray(row?.parts) ? (row.parts as unknown[]) : [];
    const recipients = Math.max(1, ...rows.map((part) => (count(fields(part)?.recipientIndex) ? (fields(part)?.recipientIndex as number) + 1 : 1)));
    if (!row || operationId === null || seen.has(operationId) || !count(row.subscriptionId) || typeof row.bindingHash !== "string" || recipients > SMS_DIRECT_MAX_RECIPIENTS) return undefined;
    const record = smsRecord(row, recipients, operationId, row.subscriptionId, row.bindingHash);
    if (record === undefined) return undefined;
    seen.add(operationId);
    out.push(record);
  }
  return out;
}

/** @throws {never} */
export function isIncompleteSmsRow(row: ThreadRow | MessageRow): row is IncompleteSmsThread | IncompleteSmsMessage {
  return "incomplete" in row && row.incomplete === true;
}

function addresses(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.length <= 20 && value.every((one) => text(one, 64)) ? [...value] : undefined;
}

/** @throws {never} */
export function parseThreads(value: unknown, limit: number): ThreadRow[] | undefined {
  const rows = fields(value)?.threads;
  if (!Array.isArray(rows) || rows.length > limit) return undefined;
  const seen = new Set<string>();
  const out: ThreadRow[] = [];
  for (const entry of rows) {
    const row = fields(entry);
    const id = threadIdOf(row?.id);
    if (!row || id === null || seen.has(id) || !count(row.date)) return undefined;
    seen.add(id);
    if (row.incomplete !== undefined) {
      if (row.incomplete !== true || Object.keys(row).length !== 4 || !oneOf(SMS_INCOMPLETE_REASONS, row.reason)) return undefined;
      out.push({ id, date: row.date, incomplete: true, reason: row.reason });
      continue;
    }
    const listed = addresses(row.addresses);
    if (!count(row.messageCount) || !text(row.snippet, 160) || typeof row.unread !== "boolean" || listed === undefined) return undefined;
    out.push({ id, date: row.date, messageCount: row.messageCount, snippet: row.snippet, unread: row.unread, addresses: listed });
  }
  return out;
}

function deliveryHolds(kind: MessageKind, direction: MessageDirection, status: MessageStatus, report: unknown): report is DeliveryReport | null {
  if (report === null) return !(kind === "sms" && direction === "outgoing") && status !== "delivered";
  return kind === "sms" && direction === "outgoing" && oneOf(REPORTS, report) && (status !== "delivered" || report === "complete");
}

/** @throws {never} */
export function parseMessages(value: unknown, threadId: ThreadId, limit: number): MessageRow[] | undefined {
  const rows = fields(value)?.messages;
  if (!Array.isArray(rows) || rows.length > limit) return undefined;
  const seen = new Set<string>();
  const out: MessageRow[] = [];
  for (const entry of rows) {
    const row = fields(entry);
    const kind = row?.kind;
    if (!row || (kind !== "sms" && kind !== "mms") || !text(row.id, 32) || !MESSAGE_ID.test(row.id) || !row.id.startsWith(`${kind}:`)) return undefined;
    const id = row.id as MessageId;
    if (seen.has(id) || row.threadId !== threadId || !count(row.date)) return undefined;
    seen.add(id);
    if (row.incomplete !== undefined) {
      if (row.incomplete !== true || Object.keys(row).length !== 6 || !oneOf(SMS_INCOMPLETE_REASONS, row.reason)) return undefined;
      out.push({ id, kind, threadId, date: row.date, incomplete: true, reason: row.reason });
      continue;
    }
    const direction = row.direction;
    const status = row.status;
    if (direction !== "incoming" && direction !== "outgoing") return undefined;
    if (!oneOf(direction === "incoming" ? INCOMING : OUTGOING, status) || !deliveryHolds(kind, direction, status, row.deliveryReport)) return undefined;
    const subscriptionId = row.subscriptionId;
    const listed = addresses(row.addresses);
    if ((subscriptionId !== null && !count(subscriptionId)) || listed === undefined) return undefined;
    if (typeof row.read !== "boolean" || !text(row.body, 2000) || !count(row.attachments)) return undefined;
    out.push({
      id,
      kind,
      threadId,
      direction,
      status,
      date: row.date,
      read: row.read,
      subscriptionId,
      addresses: listed,
      body: row.body,
      deliveryReport: row.deliveryReport,
      attachments: row.attachments,
    });
  }
  return out;
}

/** @throws {never} */
export function parseLatestSender(value: unknown, includeAddress: boolean): SmsLatestSender | undefined {
  const data = fields(value);
  if (!data) return undefined;
  if (data.status === "empty" || data.status === "sender-unavailable") return fields(value, ["status"]) ? { status: data.status } : undefined;
  if (data.status !== "found") return undefined;
  if (!includeAddress) {
    const ending = fields(value, ["status", "numberEnding"])?.numberEnding;
    return typeof ending === "string" && ending.length === senderSuffixDigits && /^[0-9]+$/.test(ending) ? { status: "found", numberEnding: ending } : undefined;
  }
  const withThread = Object.hasOwn(data, "threadId");
  if (!fields(value, withThread ? ["status", "address", "threadId"] : ["status", "address"])) return undefined;
  const address = typeof data.address === "string" && /^\+?[0-9]+$/.test(data.address) && senderNumberAdmitted(data.address.replace("+", "").length) ? (data.address as PhoneNumber) : null;
  const threadId = withThread ? threadIdOf(data.threadId) : undefined;
  if (address === null || threadId === null) return undefined;
  return threadId === undefined ? { status: "found", address } : { status: "found", address, threadId };
}

/** @throws {never} */
export function parseMessageDeleteReference(value: unknown): MessageDeleteReference | undefined {
  const data = fields(value, ["id", "kind", "threadId", "date"]);
  const threadId = threadIdOf(data?.threadId);
  if (!data || (data.kind !== "sms" && data.kind !== "mms") || threadId === null || !count(data.date)) return undefined;
  if (!text(data.id, 32) || !MESSAGE_ID.test(data.id) || !data.id.startsWith(`${data.kind}:`)) return undefined;
  return { id: data.id as MessageId, kind: data.kind, threadId, date: data.date };
}

/** @throws {never} */
function stagingFields(value: unknown, key: string): Fields | undefined {
  const queued = fields(value)?.status === "queued";
  return fields(value, queued ? ["status", key, "deletion"] : ["status", key]);
}

/** @throws {never} */
export function parseMessageDeleteResult(value: unknown, expected: MessageDeleteReference): StagingAnswer<MessageDeleteStatus, MessageDeleteReference> | undefined {
  const data = stagingFields(value, "message");
  const message = parseMessageDeleteReference(data?.message);
  if (!data || !oneOf(DELETE_STATUSES, data.status) || message === undefined) return undefined;
  const same = message.id === expected.id && message.kind === expected.kind && message.threadId === expected.threadId && message.date === expected.date;
  return same ? { status: data.status, deleteStatus: DELETE_STATUS[data.status], reference: message, deletion: data.deletion } : undefined;
}

/** @throws {never} */
export function parseThreadDeleteReference(value: unknown): ThreadDeleteReference | undefined {
  const data = fields(value, ["threadId", "through"]);
  const threadId = threadIdOf(data?.threadId);
  if (!data || threadId === null || !count(data.through) || data.through === 0) return undefined;
  return { threadId, through: data.through };
}

/** @throws {never} */
export function parseThreadDeleteResult(value: unknown, expected: ThreadDeleteReference): StagingAnswer<ThreadDeleteStatus, ThreadDeleteReference> | undefined {
  const data = stagingFields(value, "thread");
  const thread = parseThreadDeleteReference(data?.thread);
  if (!data || !oneOf(THREAD_DELETE_STATUSES, data.status) || thread === undefined) return undefined;
  const same = thread.threadId === expected.threadId && thread.through === expected.through;
  return same ? { status: data.status, deleteStatus: DELETE_STATUS[data.status], reference: thread, deletion: data.deletion } : undefined;
}
