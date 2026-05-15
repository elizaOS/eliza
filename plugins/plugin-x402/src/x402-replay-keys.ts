import { createHash } from "node:crypto";

function sha256Utf8(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

/**
 * Replay key for facilitator payment IDs (sanitized id → stable hash).
 */
export function paymentIdReplayKey(paymentId: string): string | null {
  const cleaned = paymentId.trim();
  if (!/^[a-zA-Z0-9_-]+$/.test(cleaned) || cleaned.length > 128) return null;
  return `fac:${sha256Utf8(cleaned)}`;
}

function looksMostlyPrintableAscii(s: string): boolean {
  if (!s || s.length > 100_000) return false;
  let ok = 0;
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (
      code === 9 ||
      code === 10 ||
      code === 13 ||
      (code >= 32 && code < 127)
    ) {
      ok++;
    }
  }
  return ok / s.length > 0.85;
}

function tryBase64Utf8(proof: string): string | null {
  const t = proof.trim();
  if (t.length < 8 || !/^[A-Za-z0-9+/=_-]+$/.test(t.replace(/\s/g, ""))) {
    return null;
  }
  const buf = Buffer.from(t, "base64");
  if (buf.length === 0) return null;
  const decoded = buf.toString("utf8");
  if (!decoded || decoded.includes("\0")) return null;
  if (!looksMostlyPrintableAscii(decoded)) return null;
  return decoded;
}

/**
 * For route handlers: only treat the proof as base64-wrapped UTF-8 when it passes
 * the same heuristics as replay-key extraction. Raw `0x…` tx hashes and colon proofs
 * stay intact (unlike unconditional `Buffer.from(s, "base64")`).
 */
export function decodePaymentProofForParsing(proof: string): string {
  return tryBase64Utf8(proof) ?? proof;
}

function addEvmTxHashes(s: string, into: Set<string>): void {
  const matches = s.match(/0x[a-fA-F0-9]{64}/g);
  if (!matches) return;
  for (const h of matches) into.add(`evm-tx:${h.toLowerCase()}`);
}

function addSolanaTxSignatures(s: string, into: Set<string>): void {
  const parts = s.split(":");
  if (parts.length >= 3 && parts[0]?.toUpperCase() === "SOLANA") {
    const sig = parts[2]?.trim();
    if (sig && /^[1-9A-HJ-NP-Za-km-z]{87,88}$/.test(sig)) {
      into.add(`sol-tx:${sig}`);
    }
  }
  const trimmed = s.trim().split(/\s+/)[0] ?? "";
  if (/^[1-9A-HJ-NP-Za-km-z]{87,88}$/.test(trimmed)) {
    into.add(`sol-tx:${trimmed}`);
  }
}

function addEip712StableKey(s: string, into: Set<string>): void {
  let obj: unknown;
  try {
    obj = JSON.parse(s);
  } catch {
    return;
  }
  if (typeof obj !== "object" || obj === null) return;
  const root = obj as Record<string, unknown>;
  const payload = root.payload as Record<string, unknown> | undefined;
  const auth = (payload?.authorization ?? root.authorization) as
    | Record<string, unknown>
    | undefined;
  if (!auth || typeof auth !== "object") return;
  const domain = (payload?.domain ?? root.domain) as
    | Record<string, unknown>
    | undefined;
  if (
    typeof auth.from !== "string" ||
    typeof auth.to !== "string" ||
    typeof auth.value !== "string" ||
    typeof auth.nonce !== "string"
  ) {
    return;
  }
  const contract =
    domain && typeof domain.verifyingContract === "string"
      ? domain.verifyingContract.toLowerCase()
      : "";
  const chainId =
    domain && typeof domain.chainId === "number" ? domain.chainId : -1;
  const stable = JSON.stringify({
    c: contract,
    ch: chainId,
    f: auth.from.toLowerCase(),
    t: auth.to.toLowerCase(),
    v: auth.value,
    n: auth.nonce,
  });
  into.add(`eip712:${sha256Utf8(stable)}`);
}

/**
 * Canonical replay keys derivable from a payment proof string (raw or base64-wrapped).
 * Same on-chain tx / Solana signature / EIP-712 intent maps to the same key regardless
 * of outer encoding (e.g. base64 vs plain).
 */
export function replayKeysFromProofString(proof: string): string[] {
  const keys = new Set<string>();
  const variants = new Set<string>([proof]);
  const decoded = tryBase64Utf8(proof);
  if (decoded) variants.add(decoded);
  for (const v of variants) {
    addEvmTxHashes(v, keys);
    addSolanaTxSignatures(v, keys);
    addEip712StableKey(v, keys);
  }
  return [...keys];
}

/**
 * All replay keys to consult before verification and to mark after a successful one.
 */
export function collectReplayKeysToCheck(
  paymentProof?: string,
  paymentId?: string,
): string[] {
  const keys = new Set<string>();
  if (paymentId) {
    const pk = paymentIdReplayKey(paymentId);
    if (pk) keys.add(pk);
  }
  if (paymentProof) {
    for (const k of replayKeysFromProofString(paymentProof)) keys.add(k);
  }
  return [...keys];
}
