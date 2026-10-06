/**
 * Blooio/iMessage environment isolation (#22787).
 *
 * Staging must run on its own Blooio account, sender number and webhook
 * signing secret. Distinct signing secrets key each environment's webhooks, so
 * a staging webhook can never verify in production. This module adds the
 * guard that holds even while an environment is misconfigured. A
 * non-production deployment refuses to operate a production sender number,
 * and ignores any inbound message addressed to one, so a copied credential or
 * a misrouted subscription cannot turn staging into a second production
 * ingress. That second ingress would also send replies from the production
 * line.
 */

/**
 * Publicly advertised production sender numbers (E.164). The homepage
 * readiness check (`packages/cloud/scripts/gateway/check-homepage-public-readiness.ts`)
 * publishes the same number.
 */
export const PRODUCTION_BLOOIO_SENDER_NUMBERS: readonly string[] = [
  "+18087881821",
];

export type BlooioDeploymentEnvironment = "production" | "non-production";

/** Canonical comparison form for a phone-number identity: digits only. */
export function normalizeBlooioNumber(
  value: string | null | undefined,
): string | null {
  const digits = value?.replace(/[^0-9]/g, "") ?? "";
  return digits.length >= 7 ? digits : null;
}

const PRODUCTION_DIGITS = new Set(
  PRODUCTION_BLOOIO_SENDER_NUMBERS.map((number) =>
    normalizeBlooioNumber(number),
  ).filter((number): number is string => number !== null),
);

export function isProductionBlooioNumber(
  value: string | null | undefined,
): boolean {
  const normalized = normalizeBlooioNumber(value);
  return normalized !== null && PRODUCTION_DIGITS.has(normalized);
}

/**
 * Classify a deployment label. Only an explicit production label is
 * production; any other explicit label (staging, preview, local) is
 * non-production. An absent label returns null so callers can decide.
 */
export function classifyBlooioEnvironment(
  label: string | null | undefined,
): BlooioDeploymentEnvironment | null {
  const normalized = label?.trim().toLowerCase();
  if (!normalized) return null;
  return normalized === "production" ? "production" : "non-production";
}

export type BlooioIsolationViolation =
  | "production_sender_outside_production"
  | "production_recipient_outside_production";

/** Configured sender check: a non-production deployment may not own a production line. */
export function blooioSenderIsolationViolation(input: {
  environment: BlooioDeploymentEnvironment | null;
  senderNumber: string | null | undefined;
}): BlooioIsolationViolation | null {
  return input.environment === "non-production" &&
    isProductionBlooioNumber(input.senderNumber)
    ? "production_sender_outside_production"
    : null;
}

/** Inbound check: a non-production deployment never processes production traffic. */
export function blooioRecipientIsolationViolation(input: {
  environment: BlooioDeploymentEnvironment | null;
  recipientNumber: string | null | undefined;
}): BlooioIsolationViolation | null {
  return input.environment === "non-production" &&
    isProductionBlooioNumber(input.recipientNumber)
    ? "production_recipient_outside_production"
    : null;
}
