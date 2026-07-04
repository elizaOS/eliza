import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { coveQuoteToTeeEvidence, verifyCoveQuote } from "./cove-quote.ts";
import {
  normalizeTeeEvidence,
  type TeeEvidence,
} from "@elizaos/agent/services/tee-evidence";

const DEFAULT_DSTACK_EVIDENCE_PATHS = [
  "/run/dstack/tee-evidence.json",
  "/var/run/dstack/tee-evidence.json",
];

/**
 * Cap on the raw evidence/quote payload we will read or parse. dstack quotes
 * and certificate chains are kilobytes; anything in the megabytes is either a
 * misconfiguration or a decompression-bomb attempt (plan §5.6). Reject before
 * JSON.parse so a hostile endpoint cannot exhaust memory.
 */
const MAX_EVIDENCE_PAYLOAD_BYTES = 256 * 1024;

export type DstackTeeProviderOptions = {
  endpointUrl?: string;
  evidencePath?: string;
  fetch?: typeof fetch;
  env?: Record<string, string | undefined>;
  /**
   * Production hardening (plan §5). When set:
   *  - HTTP evidence endpoints must be https: and NODE_TLS_REJECT_UNAUTHORIZED=0
   *    is refused (defends against the disabled-TLS gateway, dstack #609).
   *  - the in-domain KMS/verifier identity is pinned (see expectedKmsPublicKey).
   * It does NOT verify the TDX/CoVE quote signature — that is BLOCKED on
   * hardware (plan Phase B2/C1) and the provider must not claim hardware trust.
   */
  requireSecureTransport?: boolean;
  /**
   * Pinned base64 SPKI public key of the expected in-domain KMS/verifier.
   * When set, evidence whose freshness.verifier-bound key does not match is
   * refused. A genuine RA-TLS handshake check is BLOCKED on hardware; this is
   * the document-level pin (plan §5.4).
   */
  expectedKmsPublicKey?: string;
  maxPayloadBytes?: number;
  /**
   * On-device CoVE path. When set, the raw CoVE quote JSON is verified against
   * `coveRotPublicKey` (the self-rooted on-device RoT anchor) with real DICE
   * Ed25519 crypto and mapped to `TeeEvidence` — instead of trusting an
   * unverified provider blob. This is the only quote path the provider verifies
   * with real cryptography (the TDX path stays BLOCKED on hardware).
   */
  coveQuoteJson?: string;
  coveRotPublicKey?: string;
  /**
   * Anti-replay binding for the on-device CoVE path. When both `coveNonce` and
   * `coveEphemeralPublicKey` are present, the quote's `body.reportData` must
   * equal SHA256(nonce || epk) or verification fails closed
   * (`report-data-mismatch`). This mirrors the binding the HTTP/KMS key-release
   * path enforces (tee-key-release.ts): a captured quote carries a different
   * nonce/epk digest and cannot be replayed. Sourced from `ELIZA_COVE_NONCE` /
   * `ELIZA_COVE_EPHEMERAL_PUBLIC_KEY` (base64) when not supplied directly.
   */
  coveNonce?: string;
  /** Ephemeral public key bytes (raw or SPKI DER) the verifier offered. */
  coveEphemeralPublicKey?: Buffer;
  /**
   * CoVE rollback floor: reject quotes whose securityVersion is below this.
   * Sourced from `ELIZA_COVE_MIN_SECURITY_VERSION` when not supplied directly.
   */
  coveMinSecurityVersion?: number;
};

export type DstackTeeProvider = {
  id: "dstack";
  collectEvidence: () => Promise<TeeEvidence>;
};

export function createDstackTeeProvider(
  options: DstackTeeProviderOptions = {},
): DstackTeeProvider {
  return {
    id: "dstack",
    collectEvidence: async () => await collectDstackTeeEvidence(options),
  };
}

export async function collectDstackTeeEvidence(
  options: DstackTeeProviderOptions = {},
): Promise<TeeEvidence> {
  const env = options.env ?? process.env;
  if (options.requireSecureTransport === true) {
    assertSecureTransportEnv(env);
  }

  const coveQuoteJson = options.coveQuoteJson ?? env.ELIZA_COVE_QUOTE_JSON;
  const coveRotPublicKey =
    options.coveRotPublicKey ?? env.ELIZA_COVE_ROT_PUBLIC_KEY;
  if (coveQuoteJson?.trim()) {
    return collectCoveEvidence(coveQuoteJson, coveRotPublicKey, options, env);
  }

  const inline = env.ELIZA_TEE_EVIDENCE_JSON;
  if (inline?.trim()) {
    return finalizeEvidence(
      parseEvidenceText(inline, maxBytes(options)),
      options,
    );
  }

  const endpointUrl =
    options.endpointUrl ?? env.ELIZA_TEE_EVIDENCE_URL ?? env.DSTACK_TAPPD_URL;
  if (endpointUrl?.trim()) {
    return finalizeEvidence(
      await collectDstackEvidenceFromHttp(endpointUrl.trim(), options),
      options,
    );
  }

  const evidencePath =
    options.evidencePath ?? env.ELIZA_TEE_EVIDENCE_PATH ?? firstDefaultPath();
  if (evidencePath) {
    return finalizeEvidence(
      parseEvidenceText(
        await readFile(evidencePath, "utf8"),
        maxBytes(options),
      ),
      options,
    );
  }

  throw new Error(
    "No dstack TEE evidence source configured. Set ELIZA_TEE_EVIDENCE_JSON, ELIZA_TEE_EVIDENCE_URL, or ELIZA_TEE_EVIDENCE_PATH.",
  );
}

function collectCoveEvidence(
  coveQuoteJson: string,
  coveRotPublicKey: string | undefined,
  options: DstackTeeProviderOptions,
  env: Record<string, string | undefined>,
): TeeEvidence {
  if (!coveRotPublicKey?.trim()) {
    throw new Error(
      "A CoVE quote requires coveRotPublicKey (the on-device RoT anchor) to verify against.",
    );
  }
  const quote = parseEvidenceText(coveQuoteJson, maxBytes(options));
  const binding = resolveCoveBinding(options, env);
  const minSecurityVersion = resolveCoveMinSecurityVersion(options, env);
  const result = verifyCoveQuote(quote, {
    trustedRotPublicKey: coveRotPublicKey.trim(),
    ...(binding === undefined
      ? {}
      : {
          expectedNonce: binding.nonce,
          ephemeralPublicKey: binding.ephemeralPublicKey,
        }),
    ...(minSecurityVersion === undefined ? {} : { minSecurityVersion }),
  });
  if (!result.verified) {
    throw new Error(
      `CoVE quote verification failed (${result.reason}): ${result.detail}`,
    );
  }
  return coveQuoteToTeeEvidence(result);
}

/**
 * Resolve the live-channel binding (nonce + ephemeral public key) for the CoVE
 * path. Both must be present to enforce the report_data binding; one without
 * the other is a misconfiguration and fails closed so a half-configured binding
 * cannot be silently skipped.
 */
function resolveCoveBinding(
  options: DstackTeeProviderOptions,
  env: Record<string, string | undefined>,
): { nonce: string; ephemeralPublicKey: Buffer } | undefined {
  const nonce = options.coveNonce ?? env.ELIZA_COVE_NONCE?.trim();
  const epk =
    options.coveEphemeralPublicKey ??
    decodeBase64(env.ELIZA_COVE_EPHEMERAL_PUBLIC_KEY?.trim());
  if (nonce === undefined && epk === undefined) return undefined;
  if (nonce === undefined || epk === undefined) {
    throw new Error(
      "A CoVE report_data binding requires both ELIZA_COVE_NONCE and ELIZA_COVE_EPHEMERAL_PUBLIC_KEY.",
    );
  }
  return { nonce, ephemeralPublicKey: epk };
}

function decodeBase64(value: string | undefined): Buffer | undefined {
  if (value === undefined || value === "") return undefined;
  return Buffer.from(value, "base64");
}

function resolveCoveMinSecurityVersion(
  options: DstackTeeProviderOptions,
  env: Record<string, string | undefined>,
): number | undefined {
  if (options.coveMinSecurityVersion !== undefined) {
    return options.coveMinSecurityVersion;
  }
  const raw = env.ELIZA_COVE_MIN_SECURITY_VERSION?.trim();
  if (!raw) return undefined;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(
      "ELIZA_COVE_MIN_SECURITY_VERSION must be a non-negative integer.",
    );
  }
  return parsed;
}

async function collectDstackEvidenceFromHttp(
  endpointUrl: string,
  options: DstackTeeProviderOptions,
): Promise<unknown> {
  const url = new URL(endpointUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("dstack TEE evidence endpoint must be http(s).");
  }
  if (options.requireSecureTransport === true && url.protocol !== "https:") {
    throw new Error(
      "dstack TEE evidence endpoint must be https: under the production profile.",
    );
  }
  const request = options.fetch ?? fetch;
  const response = await request(endpointUrl, {
    method: "GET",
    headers: { accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(
      `Failed to collect dstack TEE evidence: HTTP ${response.status}.`,
    );
  }
  return parseEvidenceText(await response.text(), maxBytes(options));
}

function finalizeEvidence(
  value: unknown,
  options: DstackTeeProviderOptions,
): TeeEvidence {
  const evidence = normalizeDstackEvidence(value);
  if (options.expectedKmsPublicKey !== undefined) {
    assertKmsIdentityPinned(evidence, options.expectedKmsPublicKey);
  }
  return evidence;
}

function parseEvidenceText(text: string, maxPayloadBytes: number): unknown {
  if (Buffer.byteLength(text, "utf8") > maxPayloadBytes) {
    throw new Error(
      `dstack TEE evidence payload exceeds ${maxPayloadBytes} bytes.`,
    );
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("dstack TEE evidence is not valid JSON.");
  }
}

function normalizeDstackEvidence(value: unknown): TeeEvidence {
  const normalized = normalizeTeeEvidence(value);
  return {
    ...normalized,
    kind: normalized.kind === "dstack" ? "dstack" : normalized.kind,
    provider: normalized.provider ?? "dstack",
  };
}

function assertKmsIdentityPinned(
  evidence: TeeEvidence,
  expectedKmsPublicKey: string,
): void {
  const presented = readKmsPublicKey(evidence);
  if (presented === undefined) {
    throw new Error(
      "dstack TEE evidence does not present a KMS public key to pin against.",
    );
  }
  if (!constantTimeStringEquals(presented, expectedKmsPublicKey)) {
    throw new Error(
      "dstack TEE evidence KMS identity does not match the pinned public key.",
    );
  }
}

function readKmsPublicKey(evidence: TeeEvidence): string | undefined {
  const raw = evidence.raw;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const value = (raw as { kmsPublicKey?: unknown }).kmsPublicKey;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function constantTimeStringEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function assertSecureTransportEnv(
  env: Record<string, string | undefined>,
): void {
  if (env.NODE_TLS_REJECT_UNAUTHORIZED === "0") {
    throw new Error(
      "Refusing dstack TEE evidence collection with NODE_TLS_REJECT_UNAUTHORIZED=0 under the production profile.",
    );
  }
}

function maxBytes(options: DstackTeeProviderOptions): number {
  return options.maxPayloadBytes ?? MAX_EVIDENCE_PAYLOAD_BYTES;
}

function firstDefaultPath(): string | undefined {
  return DEFAULT_DSTACK_EVIDENCE_PATHS.find((path) => path.length > 0);
}
