import { canonicalSettlementJson } from "./settlement-digest";
/** Shared authenticated effect receipts. All amounts are integer USD micro-units. */
export interface InferenceFundingBudgetGrant {
  id: string;
  organizationId: string;
  amountMicros: string;
  expiresAt: number;
  policyGeneration: string;
  policyEpoch: string;
}
export interface InferenceFundingBudgetAllocation {
  grantId: string;
  sequence: number;
  amountMicros: string;
}
export interface InferenceFundingBudgetConsumption {
  organizationId: string;
  requestId: string;
  amountMicros: string;
  allocations: InferenceFundingBudgetAllocation[];
  metadata: Record<string, unknown>;
  signature: string;
}
export interface InferenceFundingBudgetSeal {
  organizationId: string;
  grantId: string;
  lastSequence: number;
  consumedMicros: string;
  signature: string;
}
function consumptionPayload(
  input: Omit<InferenceFundingBudgetConsumption, "signature">,
  tag: string,
  compareGrantIds: (a: string, b: string) => number,
): string {
  return canonicalSettlementJson([
    tag,
    input.organizationId,
    input.requestId,
    input.amountMicros,
    [...input.allocations].sort((a, b) => compareGrantIds(a.grantId, b.grantId)),
    input.metadata,
  ]);
}
export function budgetConsumptionPayload(
  input: Omit<InferenceFundingBudgetConsumption, "signature">,
): string {
  // Code-unit order, not localeCompare: ICU collation is locale-dependent, so
  // the signed payload and its request digest would vary with the host locale.
  // The tag moved to v2 with this ordering change: v1 bytes ordered the
  // allocations with localeCompare, so one tag must not name both byte sets.
  return consumptionPayload(input, "inference-funding-budget-consume-v2", (a, b) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
}
/**
 * The pre-v2 payload bytes: tag `inference-funding-budget-consume-v1` with
 * allocations ordered by `localeCompare`, so the bytes depend on the host
 * collation. Receipts recorded before the v2 change carry signatures and
 * request digests over these bytes; the replay paths accept them so an
 * already-recorded consumption still replays instead of failing closed.
 * Never sign or store a new consumption with this payload.
 */
export function budgetConsumptionLegacyPayload(
  input: Omit<InferenceFundingBudgetConsumption, "signature">,
): string {
  return consumptionPayload(input, "inference-funding-budget-consume-v1", (a, b) =>
    a.localeCompare(b),
  );
}
export function budgetSealPayload(input: Omit<InferenceFundingBudgetSeal, "signature">): string {
  return canonicalSettlementJson([
    "inference-funding-budget-seal-v1",
    input.organizationId,
    input.grantId,
    String(input.lastSequence),
    input.consumedMicros,
  ]);
}
export async function budgetRequestDigest(payload: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload)));
}
function hex(value: ArrayBuffer): string {
  return Array.from(new Uint8Array(value), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
async function key(secret: string): Promise<CryptoKey> {
  const bytes = new TextEncoder().encode(secret);
  if (bytes.length < 32) throw new Error("Budget signing secret must contain at least 32 bytes");
  return crypto.subtle.importKey("raw", bytes, { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}
export async function signBudgetEffect(payload: string, secret: string): Promise<string> {
  return hex(
    await crypto.subtle.sign("HMAC", await key(secret), new TextEncoder().encode(payload)),
  );
}
export async function verifyBudgetEffect(
  payload: string,
  signature: string,
  secret: string,
): Promise<boolean> {
  if (!/^[0-9a-f]{64}$/.test(signature)) return false;
  const bytes = Uint8Array.from(signature.match(/../g)!, (pair) => Number.parseInt(pair, 16));
  return crypto.subtle.verify("HMAC", await key(secret), bytes, new TextEncoder().encode(payload));
}
