import { createHmac, timingSafeEqual } from "node:crypto";

export const DEFAULT_AGENT_RUN_RECEIPT_SECRET_ENV =
  "MERGE_STEWARD_AGENT_RUN_RECEIPT_SECRET";
export const AGENT_RUN_RECEIPT_SIGNATURE_ALGORITHM = "hmac-sha256";

const SIGNATURE_PREFIX = "sha256=";

export function canonicalAgentRunReceiptPayload(input = {}) {
  const state = normalizeRunState(input.state ?? input.status);
  return stableStringify(
    dropUndefined({
      runId: input.runId ?? input.id,
      state,
      failedChildren: normalizeInteger(input.failedChildren),
      failedChildKeys: normalizeStringArray(input.failedChildKeys),
      url: input.url,
      updatedAt: input.updatedAt ?? input.computedAt,
      blocked: objectOrUndefined(input.blocked),
      unhealthy: objectOrUndefined(input.unhealthy),
    }),
  );
}

export function signAgentRunReceipt(input, secret) {
  if (!secret) {
    throw new TypeError("Agent run receipt signing requires a secret");
  }
  return `${SIGNATURE_PREFIX}${hmacDigest(canonicalAgentRunReceiptPayload(input), secret)}`;
}

export function verifyAgentRunReceipt(
  input = {},
  options = {},
  env = process.env,
) {
  if (!input || typeof input !== "object") return input;

  const signature = normalizeSignature(
    input.signature ?? input.hmac ?? input.receiptSignature,
  );
  const secretEnv =
    options.signatureSecretEnv ?? DEFAULT_AGENT_RUN_RECEIPT_SECRET_ENV;
  const secret =
    options.signatureSecret ?? (secretEnv ? env[secretEnv] : undefined);
  const baseVerification = {
    method: AGENT_RUN_RECEIPT_SIGNATURE_ALGORITHM,
    signaturePresent: Boolean(signature),
    secretEnv,
  };

  if (!signature) {
    return withVerification(input, false, {
      ...baseVerification,
      status: "unsigned",
    });
  }

  if (!secret) {
    return withVerification(input, false, {
      ...baseVerification,
      status: "secret_unconfigured",
    });
  }

  const expected = signAgentRunReceipt(input, secret);
  const verified = timingSafeStringEqual(
    normalizeSignature(expected),
    signature,
  );

  return withVerification(input, verified, {
    ...baseVerification,
    status: verified ? "verified" : "signature_mismatch",
    payload: canonicalAgentRunReceiptPayload(input),
  });
}

function withVerification(input, verified, verification) {
  return {
    ...input,
    verified,
    verification,
  };
}

function hmacDigest(payload, secret) {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

function normalizeSignature(value) {
  if (!value) return null;
  const signature = String(value)
    .trim()
    .replace(/^["'`]+|["'`,]+$/g, "");
  return signature.startsWith(SIGNATURE_PREFIX)
    ? signature
    : `${SIGNATURE_PREFIX}${signature}`;
}

function timingSafeStringEqual(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function dropUndefined(input) {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined),
  );
}

function normalizeRunState(value) {
  if (!value) return undefined;
  return String(value).trim().toLowerCase().replace(/_/g, "-");
}

function normalizeInteger(value) {
  if (value == null || value === "") return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) return undefined;
  const normalized = value.map((item) => String(item).trim()).filter(Boolean);
  return normalized.length > 0 ? normalized : undefined;
}

function objectOrUndefined(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : undefined;
}
