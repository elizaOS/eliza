/**
 * Signature-curve capability registry.
 *
 * The vault can produce raw signatures on a fixed set of curves. This module is
 * the single source of truth for *which curves are supported* and *which chains
 * those curves serve*, so the cross-curve raw-digest signing surface
 * (`POST /vault/:agentId/sign-raw-digest`) has a documented, testable capability
 * matrix instead of scattered string literals.
 *
 * Design notes:
 *  - We declare curves, NOT chains-as-fully-supported. Listing a chain here means
 *    "the vault can produce a valid signature on that chain's curve" — it does
 *    NOT imply Steward has RPC / balance / transaction-builder support for it.
 *    (Over-claiming transaction support would violate the fail-closed posture.)
 *  - `stark` is intentionally unsupported: no vetted starknet curve library is
 *    installed, and hand-rolling curve crypto in a money path is unacceptable.
 *    It is listed so callers get a precise, honest reason rather than a generic
 *    "unknown curve" error.
 */

/** Signature curves the raw-digest signing surface knows about. */
export type SigningCurve = "secp256k1" | "ed25519" | "stark";

export interface SigningCurveSupport {
  curve: SigningCurve;
  /** Whether the vault can currently produce signatures on this curve. */
  supported: boolean;
  /** Human-readable reason when `supported` is false. */
  unsupportedReason?: string;
  /** Representative chains served by this curve (informational, non-exhaustive). */
  exampleChains: readonly string[];
}

export type RawSigningChain =
  | "bitcoin"
  | "spark"
  | "lightning"
  | "tron"
  | "tempo"
  | "ton"
  | "cosmos"
  | "stellar"
  | "near"
  | "sui"
  | "aptos"
  | "movement"
  | "starknet"
  | "monero";

export interface RawSigningChainSupport {
  chain: RawSigningChain;
  curve: SigningCurve;
  supported: boolean;
  unsupportedReason?: string;
  /**
   * Honest scope of vault support:
   *  - "raw-digest": the vault signs a caller-provided digest on the chain's
   *    curve; it does NOT build or broadcast transactions for the chain.
   *  - "transfer-intent": the vault builds, signs, and broadcasts native
   *    transfers via a dedicated chain route, but the generic raw-digest
   *    surface is NOT available (the chain's signature scheme is not plain
   *    ECDSA/EdDSA over a digest — e.g. Monero's CLSAG ring signatures).
   */
  capability: "raw-digest" | "transfer-intent";
}

/** Canonical reason the stark curve fails closed. Mirrors the vault's guard. */
export const STARK_UNSUPPORTED_REASON =
  "no vetted starknet signing library is installed" as const;

/** Capability matrix for raw-digest signing, keyed by curve. */
export const SIGNING_CURVE_SUPPORT: Readonly<
  Record<SigningCurve, SigningCurveSupport>
> = Object.freeze({
  secp256k1: {
    curve: "secp256k1",
    supported: true,
    // ECDSA over secp256k1 — used by EVM chains and most Bitcoin-lineage chains.
    exampleChains: [
      "ethereum",
      "base",
      "arbitrum",
      "polygon",
      "bsc",
      "bitcoin",
      "tron",
      "cosmos",
    ],
  },
  ed25519: {
    curve: "ed25519",
    supported: true,
    // EdDSA over ed25519 — used by Solana and many newer L1s.
    exampleChains: [
      "solana",
      "sui",
      "aptos",
      "movement",
      "stellar",
      "near",
      "ton",
    ],
  },
  stark: {
    curve: "stark",
    supported: false,
    unsupportedReason: STARK_UNSUPPORTED_REASON,
    exampleChains: ["starknet"],
  },
});

/** Raw-digest signing support for non-EVM/other-chain parity rows. */
export const RAW_SIGNING_CHAIN_SUPPORT: Readonly<
  Record<RawSigningChain, RawSigningChainSupport>
> = Object.freeze({
  bitcoin: {
    chain: "bitcoin",
    curve: "secp256k1",
    supported: true,
    capability: "raw-digest",
  },
  spark: {
    chain: "spark",
    curve: "secp256k1",
    supported: true,
    capability: "raw-digest",
  },
  lightning: {
    chain: "lightning",
    curve: "secp256k1",
    supported: true,
    capability: "raw-digest",
  },
  tron: {
    chain: "tron",
    curve: "secp256k1",
    supported: true,
    capability: "raw-digest",
  },
  tempo: {
    chain: "tempo",
    curve: "secp256k1",
    supported: true,
    capability: "raw-digest",
  },
  cosmos: {
    chain: "cosmos",
    curve: "secp256k1",
    supported: true,
    capability: "raw-digest",
  },
  ton: {
    chain: "ton",
    curve: "ed25519",
    supported: true,
    capability: "raw-digest",
  },
  stellar: {
    chain: "stellar",
    curve: "ed25519",
    supported: true,
    capability: "raw-digest",
  },
  near: {
    chain: "near",
    curve: "ed25519",
    supported: true,
    capability: "raw-digest",
  },
  sui: {
    chain: "sui",
    curve: "ed25519",
    supported: true,
    capability: "raw-digest",
  },
  aptos: {
    chain: "aptos",
    curve: "ed25519",
    supported: true,
    capability: "raw-digest",
  },
  movement: {
    chain: "movement",
    curve: "ed25519",
    supported: true,
    capability: "raw-digest",
  },
  starknet: {
    chain: "starknet",
    curve: "stark",
    supported: false,
    unsupportedReason: STARK_UNSUPPORTED_REASON,
    capability: "raw-digest",
  },
  // Monero uses ed25519 keys but NOT RFC-8032 EdDSA: transactions are signed
  // with CLSAG ring signatures over CryptoNote key derivation. A raw ed25519
  // digest signature is meaningless (and dangerous to pretend) for Monero, so
  // the capability is "transfer-intent": the vault builds + signs + relays
  // native transfers through the dedicated /vault/:agentId/monero routes and
  // the raw-digest surface must reject chain "monero".
  monero: {
    chain: "monero",
    curve: "ed25519",
    supported: true,
    capability: "transfer-intent",
  },
});

/** Curves the vault can actually sign with (supported === true). */
export const SUPPORTED_SIGNING_CURVES: readonly SigningCurve[] = Object.freeze(
  (Object.keys(SIGNING_CURVE_SUPPORT) as SigningCurve[]).filter(
    (c) => SIGNING_CURVE_SUPPORT[c].supported,
  ),
);

/** Type guard: is `value` a known signing curve (supported or not)? */
export function isSigningCurve(value: unknown): value is SigningCurve {
  return value === "secp256k1" || value === "ed25519" || value === "stark";
}

/** True only for curves the vault can currently produce signatures on. */
export function isSigningCurveSupported(
  value: unknown,
): value is "secp256k1" | "ed25519" {
  return isSigningCurve(value) && SIGNING_CURVE_SUPPORT[value].supported;
}

/** Look up the support record for a curve, or undefined if unknown. */
export function signingCurveSupport(
  value: unknown,
): SigningCurveSupport | undefined {
  return isSigningCurve(value) ? SIGNING_CURVE_SUPPORT[value] : undefined;
}

export function rawSigningChainSupport(
  value: unknown,
): RawSigningChainSupport | undefined {
  // `in` would also match Object.prototype members ("constructor" etc.) and
  // return them as support records; restrict to own keys (SEC-116).
  return typeof value === "string" &&
    Object.hasOwn(RAW_SIGNING_CHAIN_SUPPORT, value)
    ? RAW_SIGNING_CHAIN_SUPPORT[value as RawSigningChain]
    : undefined;
}
