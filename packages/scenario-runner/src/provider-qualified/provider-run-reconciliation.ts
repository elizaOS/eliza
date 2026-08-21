/**
 * Defines the offline, operator-signed authorization used to resolve an
 * indeterminate provider-canary journal without erasing its durable history.
 * A reconciliation statement binds one exact journal snapshot and therefore
 * cannot be replayed after any state transition.
 */

import {
  createPublicKey,
  type KeyObject,
  verify as verifySignature,
} from "node:crypto";
import {
  canonicalJson,
  canonicalJsonValue,
  canonicalSha256,
} from "./manifest.ts";
import { providerObserverKeyId } from "./qualification.ts";
import type { ProviderQualificationPublicKeyPin } from "./qualification-artifact.ts";

export const PROVIDER_RUN_RECONCILIATION_SCHEMA =
  "eliza.provider-run-reconciliation.v1" as const;

export type ProviderRunJournalKind = "external-canary" | "exact13";
export type ProviderRunReconciliationAction =
  | "recover-staged-publication"
  | "abandon-proven-pre-ingress"
  | "acknowledge-provider-reconciled";

export interface ProviderRunReconciliationPayload {
  schema: typeof PROVIDER_RUN_RECONCILIATION_SCHEMA;
  journalKind: ProviderRunJournalKind;
  journalSha256: string;
  targetSha256: string;
  action: ProviderRunReconciliationAction;
  issuedAtIso: string;
  expiresAtIso: string;
  nonce: string;
}

export interface SignedProviderRunReconciliation {
  payload: ProviderRunReconciliationPayload;
  signer: {
    keyId: string;
    algorithm: "ed25519";
  };
  signature: string;
}

const SHA256 = /^[a-f0-9]{64}$/;
const BASE64URL_SIGNATURE = /^[A-Za-z0-9_-]{86}$/;
const MAX_RECONCILIATION_LIFETIME_MS = 15 * 60_000;

function fail(message: string): never {
  throw new Error(`provider run reconciliation ${message}`);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  ) {
    fail(`${label} must be a plain object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  label: string,
  keys: readonly string[],
): void {
  const actual = Object.keys(value);
  const missing = keys.filter((key) => !Object.hasOwn(value, key));
  const unknown = actual.filter((key) => !keys.includes(key));
  if (missing.length || unknown.length) {
    fail(
      `${label} violates the closed shape (missing=${missing.join(",") || "none"}; unknown=${unknown.join(",") || "none"})`,
    );
  }
}

function canonicalIso(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(Date.parse(value)).toISOString() !== value
  ) {
    fail(`${label} must be a canonical ISO timestamp`);
  }
  return value;
}

/** Return the digest that an offline reconciliation request must bind. */
export function providerRunJournalSha256(journal: unknown): string {
  return canonicalSha256(journal, "providerRunJournal");
}

/** Return the domain-separated bytes an offline operator must sign. */
export function providerRunReconciliationSigningBytes(
  payload: ProviderRunReconciliationPayload,
): Buffer {
  return Buffer.from(
    `eliza.provider-run-reconciliation.v1\n${canonicalJson(
      canonicalJsonValue(payload, "providerRunReconciliationPayload"),
    )}`,
    "utf8",
  );
}

/**
 * Verify a one-use reconciliation statement against externally pinned
 * manifest-authority keys and the exact journal bytes observed by the caller.
 */
export function verifySignedProviderRunReconciliation(input: {
  value: unknown;
  journal: unknown;
  expectedJournalKind: ProviderRunJournalKind;
  expectedTargetSha256: string;
  expectedAction: ProviderRunReconciliationAction;
  authorityPins: readonly ProviderQualificationPublicKeyPin[];
  now?: Date;
}): SignedProviderRunReconciliation {
  const envelope = record(
    canonicalJsonValue(input.value, "providerRunReconciliation"),
    "statement",
  );
  exactKeys(envelope, "statement", ["payload", "signer", "signature"]);
  const payload = record(envelope.payload, "statement.payload");
  exactKeys(payload, "statement.payload", [
    "schema",
    "journalKind",
    "journalSha256",
    "targetSha256",
    "action",
    "issuedAtIso",
    "expiresAtIso",
    "nonce",
  ]);
  const signer = record(envelope.signer, "statement.signer");
  exactKeys(signer, "statement.signer", ["keyId", "algorithm"]);
  if (payload.schema !== PROVIDER_RUN_RECONCILIATION_SCHEMA)
    fail("schema is unsupported");
  if (payload.journalKind !== input.expectedJournalKind)
    fail("journal kind does not match the requested operation");
  if (payload.action !== input.expectedAction)
    fail("action does not match the requested operation");
  if (
    typeof payload.journalSha256 !== "string" ||
    !SHA256.test(payload.journalSha256) ||
    payload.journalSha256 !== providerRunJournalSha256(input.journal)
  ) {
    fail("journal digest is stale or invalid");
  }
  if (
    typeof payload.targetSha256 !== "string" ||
    !SHA256.test(payload.targetSha256) ||
    payload.targetSha256 !== input.expectedTargetSha256
  ) {
    fail("target digest does not match the protected run");
  }
  if (
    typeof payload.nonce !== "string" ||
    payload.nonce.length < 16 ||
    payload.nonce.length > 256
  ) {
    fail("nonce must contain 16-256 characters");
  }
  const issuedAtIso = canonicalIso(
    payload.issuedAtIso,
    "statement.payload.issuedAtIso",
  );
  const expiresAtIso = canonicalIso(
    payload.expiresAtIso,
    "statement.payload.expiresAtIso",
  );
  const issuedAt = Date.parse(issuedAtIso);
  const expiresAt = Date.parse(expiresAtIso);
  const now = (input.now ?? new Date()).getTime();
  if (
    expiresAt <= issuedAt ||
    expiresAt - issuedAt > MAX_RECONCILIATION_LIFETIME_MS ||
    now < issuedAt - 5_000 ||
    now > expiresAt
  ) {
    fail("statement is expired, premature, or valid for too long");
  }
  if (
    typeof signer.keyId !== "string" ||
    !SHA256.test(signer.keyId) ||
    signer.algorithm !== "ed25519"
  ) {
    fail("signer is invalid");
  }
  if (
    typeof envelope.signature !== "string" ||
    !BASE64URL_SIGNATURE.test(envelope.signature)
  ) {
    fail("signature must be a canonical Ed25519 base64url value");
  }
  const pin = input.authorityPins.find(({ keyId }) => keyId === signer.keyId);
  if (pin?.algorithm !== "ed25519")
    fail("signer is not an authorized manifest authority");
  let publicKey: KeyObject;
  try {
    publicKey = createPublicKey(pin.spkiPem);
  } catch (error) {
    throw new Error("provider run reconciliation authority pin is invalid", {
      cause: error,
    });
  }
  if (
    publicKey.asymmetricKeyType !== "ed25519" ||
    providerObserverKeyId(pin.spkiPem) !== pin.keyId ||
    !verifySignature(
      null,
      providerRunReconciliationSigningBytes(
        payload as unknown as ProviderRunReconciliationPayload,
      ),
      publicKey,
      Buffer.from(envelope.signature, "base64url"),
    )
  ) {
    fail("signature is invalid");
  }
  return canonicalJsonValue(
    envelope,
    "providerRunReconciliation",
  ) as unknown as SignedProviderRunReconciliation;
}

/** Canonical payload helper for offline authoring tools and HSM clients. */
export function createProviderRunReconciliationPayload(
  input: Omit<ProviderRunReconciliationPayload, "schema">,
): ProviderRunReconciliationPayload {
  return canonicalJsonValue(
    { schema: PROVIDER_RUN_RECONCILIATION_SCHEMA, ...input },
    "providerRunReconciliationPayload",
  ) as unknown as ProviderRunReconciliationPayload;
}
