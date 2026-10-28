/** A reviewed SIM send. Submission, modem send and delivery are separate observations. */
export const SMS_SEND_CAPABILITY = "sms.send.v1";
export type SmsSendOperation = {
  type: "sms_send";
  recipients: string[];
  body: string;
  subscriptionId: number;
};
type PartState = "unknown" | "success" | "failed";
export type SmsSendResult = {
  kind: "sms-send";
  operationId: string;
  subscriptionId: number;
  bindingHash: string;
  status:
    | "cancelled"
    | "denied"
    | "failed"
    | "unknown"
    | "submitted"
    | "sent"
    | "delivered";
  parts: {
    index: number;
    recipientIndex: number;
    partIndex: number;
    sent: PartState;
    delivery: PartState;
  }[];
  createdAt: number;
};
function obj(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("Invalid SMS record");
  return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, keys: string[]) {
  if (
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    throw Error("Unexpected SMS fields");
}
export function isSmsSend(value: {
  type?: unknown;
}): value is SmsSendOperation {
  return value.type === "sms_send";
}
export function validateSmsSend(value: unknown): SmsSendOperation {
  const v = obj(value);
  exact(v, ["type", "recipients", "body", "subscriptionId"]);
  if (
    v.type !== "sms_send" ||
    !Array.isArray(v.recipients) ||
    v.recipients.length < 1 ||
    v.recipients.length > 5 ||
    v.recipients.some(
      (n) => typeof n !== "string" || !/^\+?[0-9]{2,20}$/.test(n),
    ) ||
    new Set(v.recipients).size !== v.recipients.length ||
    typeof v.body !== "string" ||
    !v.body.length ||
    v.body.length > 1600 ||
    v.body.includes("\0") ||
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(
      v.body,
    ) ||
    !Number.isSafeInteger(v.subscriptionId) ||
    (v.subscriptionId as number) < 0 ||
    (v.subscriptionId as number) > 2147483647
  )
    throw Error("Invalid reviewed SMS");
  return {
    type: "sms_send",
    recipients: [...v.recipients] as string[],
    body: v.body,
    subscriptionId: v.subscriptionId as number,
  };
}
/** Hash UTF-8 with SHA-256. Fixed field order is shared with the native journal. */
export function smsBindingText(operation: SmsSendOperation): string {
  const v = validateSmsSend(operation);
  return JSON.stringify({
    body: v.body,
    recipients: v.recipients,
    subscriptionId: v.subscriptionId,
    type: v.type,
  });
}
export function validateSmsResult(
  op: SmsSendOperation,
  value: unknown,
  operationId: string,
  bindingHash: string,
): SmsSendResult {
  const v = obj(value);
  exact(v, [
    "kind",
    "operationId",
    "subscriptionId",
    "bindingHash",
    "status",
    "parts",
    "createdAt",
  ]);
  if (
    v.kind !== "sms-send" ||
    v.operationId !== operationId ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(operationId) ||
    v.subscriptionId !== op.subscriptionId ||
    v.bindingHash !== bindingHash ||
    !/^[a-f0-9]{64}$/.test(bindingHash) ||
    ![
      "cancelled",
      "denied",
      "failed",
      "unknown",
      "submitted",
      "sent",
      "delivered",
    ].includes(v.status as string) ||
    !Number.isSafeInteger(v.createdAt) ||
    (v.createdAt as number) <= 0 ||
    !Array.isArray(v.parts) ||
    v.parts.length > 50
  )
    throw Error("SMS receipt binding changed");
  const counts = op.recipients.map(() => 0);
  let previousRecipient = 0;
  const parts = v.parts.map((raw, index) => {
    const p = obj(raw);
    exact(p, ["index", "recipientIndex", "partIndex", "sent", "delivery"]);
    const recipient = p.recipientIndex as number;
    if (
      p.index !== index ||
      !Number.isInteger(recipient) ||
      recipient < previousRecipient ||
      recipient > previousRecipient + 1 ||
      recipient >= counts.length ||
      (index === 0 && recipient !== 0) ||
      p.partIndex !== counts[recipient] ||
      counts[recipient] >= 10 ||
      !["unknown", "success", "failed"].includes(p.sent as string) ||
      !["unknown", "success", "failed"].includes(p.delivery as string) ||
      (p.delivery === "success" && p.sent !== "success")
    )
      throw Error("Invalid SMS part evidence");
    counts[recipient]++;
    previousRecipient = recipient;
    return {
      index,
      recipientIndex: recipient,
      partIndex: p.partIndex as number,
      sent: p.sent as PartState,
      delivery: p.delivery as PartState,
    };
  });
  if (
    (["cancelled", "denied"].includes(v.status as string) &&
      parts.length !== 0) ||
    (["submitted", "sent", "delivered"].includes(v.status as string) &&
      counts.some((count) => !count)) ||
    (["sent", "delivered"].includes(v.status as string) &&
      parts.some((p) => p.sent !== "success")) ||
    (v.status === "delivered" && parts.some((p) => p.delivery !== "success")) ||
    (v.status === "submitted" &&
      parts.some((p) => p.sent === "failed" || p.delivery === "failed"))
  )
    throw Error("SMS status is not supported by part evidence");
  return {
    kind: "sms-send",
    operationId,
    subscriptionId: op.subscriptionId,
    bindingHash,
    status: v.status as SmsSendResult["status"],
    parts,
    createdAt: v.createdAt as number,
  };
}
export function smsReceiptOutcome(
  result: SmsSendResult,
): "applied" | "failed" | "unknown" {
  if (["submitted", "sent", "delivered"].includes(result.status))
    return "applied";
  return result.status === "cancelled" || result.status === "denied"
    ? "failed"
    : "unknown";
}
