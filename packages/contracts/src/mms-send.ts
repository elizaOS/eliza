/**
 * A reviewed SIM multimedia send: one MMS to every recipient (a group conversation when there are
 * several), with optional text and image attachments. Submission and the carrier's send
 * confirmation are separate observations. MMS delivery is never claimed: carriers deliver
 * delivery reports as separate notifications that cannot be bound to a reviewed send reliably.
 */
export const MMS_SEND_CAPABILITY = "mms.send.v1";
export const MMS_MAX_RECIPIENTS = 10;
export const MMS_MAX_ATTACHMENTS = 5;
export const MMS_MAX_BODY = 1600;
/** Upper bound of the contract. The native host also refuses anything over the carrier's limit. */
export const MMS_MAX_TOTAL_BYTES = 1024 * 1024;
export const MMS_ATTACHMENT_TYPES = [
  "image/jpeg",
  "image/png",
  "image/gif",
] as const;
export type MmsAttachmentType = (typeof MMS_ATTACHMENT_TYPES)[number];
/** What is bound and reviewed: the exact bytes are identified by their SHA-256 and size. */
export type MmsAttachmentBinding = {
  contentType: MmsAttachmentType;
  name: string;
  sha256: string;
  size: number;
};
export type MmsSendOperation = {
  type: "mms_send";
  recipients: string[];
  body: string;
  attachments: MmsAttachmentBinding[];
  subscriptionId: number;
};
export type MmsSendResult = {
  kind: "mms-send";
  operationId: string;
  subscriptionId: number;
  bindingHash: string;
  status: "cancelled" | "denied" | "failed" | "unknown" | "submitted" | "sent";
  createdAt: number;
};
export const MMS_STATUSES: readonly MmsSendResult["status"][] = [
  "cancelled",
  "denied",
  "failed",
  "unknown",
  "submitted",
  "sent",
];

function obj(value: unknown, what: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error(`Invalid ${what}`);
  return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, keys: string[]) {
  if (
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    throw Error("Unexpected MMS fields");
}
const LONE_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function isMmsSend(value: {
  type?: unknown;
}): value is MmsSendOperation {
  return value.type === "mms_send";
}

function validateAttachment(raw: unknown): MmsAttachmentBinding {
  const a = obj(raw, "MMS attachment");
  exact(a, ["contentType", "name", "sha256", "size"]);
  if (
    !MMS_ATTACHMENT_TYPES.includes(a.contentType as MmsAttachmentType) ||
    typeof a.name !== "string" ||
    !NAME.test(a.name) ||
    typeof a.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(a.sha256) ||
    !Number.isSafeInteger(a.size) ||
    (a.size as number) < 1 ||
    (a.size as number) > MMS_MAX_TOTAL_BYTES
  )
    throw Error("Invalid MMS attachment");
  return {
    contentType: a.contentType as MmsAttachmentType,
    name: a.name,
    sha256: a.sha256,
    size: a.size as number,
  };
}

export function validateMmsSend(value: unknown): MmsSendOperation {
  const v = obj(value, "reviewed MMS");
  exact(v, ["type", "recipients", "body", "attachments", "subscriptionId"]);
  if (
    v.type !== "mms_send" ||
    !Array.isArray(v.recipients) ||
    v.recipients.length < 1 ||
    v.recipients.length > MMS_MAX_RECIPIENTS ||
    v.recipients.some(
      (n) => typeof n !== "string" || !/^\+?[0-9]{2,20}$/.test(n),
    ) ||
    new Set(v.recipients).size !== v.recipients.length ||
    typeof v.body !== "string" ||
    v.body.length > MMS_MAX_BODY ||
    v.body.includes("\0") ||
    LONE_SURROGATE.test(v.body) ||
    !Array.isArray(v.attachments) ||
    v.attachments.length > MMS_MAX_ATTACHMENTS ||
    !Number.isSafeInteger(v.subscriptionId) ||
    (v.subscriptionId as number) < 0 ||
    (v.subscriptionId as number) > 2147483647
  )
    throw Error("Invalid reviewed MMS");
  const attachments = v.attachments.map(validateAttachment);
  if (!v.body.length && !attachments.length)
    throw Error("An MMS needs text or an attachment");
  if (new Set(attachments.map((a) => a.name)).size !== attachments.length)
    throw Error("MMS attachment names must be distinct");
  if (attachments.reduce((sum, a) => sum + a.size, 0) > MMS_MAX_TOTAL_BYTES)
    throw Error("MMS is too large");
  return {
    type: "mms_send",
    recipients: [...v.recipients] as string[],
    body: v.body,
    attachments,
    subscriptionId: v.subscriptionId as number,
  };
}

/** Hash UTF-8 with SHA-256. Fixed field order is shared with the native journal. */
export function mmsBindingText(operation: MmsSendOperation): string {
  const v = validateMmsSend(operation);
  return JSON.stringify({
    attachments: v.attachments.map((a) => ({
      contentType: a.contentType,
      name: a.name,
      sha256: a.sha256,
      size: a.size,
    })),
    body: v.body,
    recipients: v.recipients,
    subscriptionId: v.subscriptionId,
    type: v.type,
  });
}

export function validateMmsResult(
  op: MmsSendOperation,
  value: unknown,
  operationId: string,
  bindingHash: string,
): MmsSendResult {
  const v = obj(value, "MMS record");
  exact(v, [
    "kind",
    "operationId",
    "subscriptionId",
    "bindingHash",
    "status",
    "createdAt",
  ]);
  if (
    v.kind !== "mms-send" ||
    v.operationId !== operationId ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(operationId) ||
    v.subscriptionId !== op.subscriptionId ||
    v.bindingHash !== bindingHash ||
    !/^[a-f0-9]{64}$/.test(bindingHash) ||
    !MMS_STATUSES.includes(v.status as MmsSendResult["status"]) ||
    !Number.isSafeInteger(v.createdAt) ||
    (v.createdAt as number) <= 0
  )
    throw Error("MMS receipt binding changed");
  return {
    kind: "mms-send",
    operationId,
    subscriptionId: op.subscriptionId,
    bindingHash,
    status: v.status as MmsSendResult["status"],
    createdAt: v.createdAt as number,
  };
}

export function mmsReceiptOutcome(
  result: MmsSendResult,
): "applied" | "failed" | "unknown" {
  if (result.status === "submitted" || result.status === "sent")
    return "applied";
  return result.status === "cancelled" || result.status === "denied"
    ? "failed"
    : "unknown";
}
