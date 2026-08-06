/**
 * ZK Agent configuration.
 *
 * Loaded from environment variables so the same agent binary works
 * locally, in CI, and in production without code changes.
 *
 * Required:
 *   CLAWD_ZK_RPC_URL        — Solana RPC endpoint (Helius recommended)
 *   CLAWD_ZK_PROGRAM_ID     — Address of the deployed `clawd-zk` program
 *
 * Optional:
 *   CLAWD_ZK_PHOTON_URL     — Photon indexer URL (defaults to the RPC URL)
 *   CLAWD_ZK_API_KEY        — Separate API key for the RPC (some providers)
 *   CLAWD_ZK_COMMITMENT     — "processed" | "confirmed" | "finalized" (default "confirmed")
 *   CLAWD_ZK_KEYPAIR        — Path to a Solana CLI keypair JSON for signing
 *   CLAWD_ZK_NETWORK        — "mainnet" | "devnet" | "localnet" (for intent hints)
 */

import { PublicKey } from "@solana/web3.js";

/**
 * Default program id used by the deployed `clawd-zk` program on mainnet.
 *
 * 32 base-58 chars; corresponds to the placeholder 32-byte buffer
 * 0xCL CLAWDzk11111111111111111111111111111111 (visible as a base58
 * string only at the config layer — the actual program address is
 * set when the Anchor IDL is built and deployed).
 */
export const DEFAULT_PROGRAM_ID = new PublicKey(
  "CLAWDzk1111111111111111111111111111111111111",
);

export interface ZkAgentConfig {
  /** Helius or other Solana RPC URL (api-key may be embedded). */
  rpcUrl: string;
  /** Address of the deployed `clawd-zk` program. */
  programId: PublicKey;
  /** Photon indexer URL. Defaults to `rpcUrl`. */
  photonUrl: string;
  /** Separate API key for the RPC. */
  apiKey?: string;
  /** Commitment level for RPC calls. */
  commitment: "processed" | "confirmed" | "finalized";
  /** Optional path to a Solana keypair JSON for signing. */
  keypairPath?: string;
  /** Network hint for intent routing. */
  network: "mainnet" | "devnet" | "localnet";
}

const KNOWN_PROGRAM_IDS: Record<string, string> = {
  CLAWDZK_MAINNET: "CLAWDzk1111111111111111111111111111111111111",
  CLAWDZK_DEVNET: "CLAWDzk2222222222222222222222222222222222222",
  CLAWDZK_LOCALNET: "CLAWDzk3333333333333333333333333333333333333",
};

function asString(v: string | undefined, fallback: string): string {
  if (v == null) return fallback;
  const trimmed = v.trim();
  return trimmed.length === 0 ? fallback : trimmed;
}

function asCommitment(v: string | undefined): ZkAgentConfig["commitment"] {
  const value = (v ?? "confirmed").toLowerCase();
  if (value === "processed" || value === "finalized") return value;
  return "confirmed";
}

function asNetwork(v: string | undefined): ZkAgentConfig["network"] {
  const value = (v ?? "mainnet").toLowerCase();
  if (value === "devnet" || value === "localnet") return value;
  return "mainnet";
}

function resolveProgramId(raw: string | undefined): PublicKey {
  if (!raw) return DEFAULT_PROGRAM_ID;
  const named = KNOWN_PROGRAM_IDS[raw.toUpperCase()];
  if (named) return new PublicKey(named);
  try {
    return new PublicKey(raw);
  } catch {
    throw new Error(
      `Invalid CLAWD_ZK_PROGRAM_ID: ${raw}. Expected a base58 pubkey or one of: ${Object.keys(KNOWN_PROGRAM_IDS).join(", ")}.`,
    );
  }
}

/**
 * Load ZK agent config from the current `process.env`.
 *
 * Throws if the required `CLAWD_ZK_RPC_URL` is not set.
 */
export function loadAgentConfig(env: Record<string, string | undefined> = process.env): ZkAgentConfig {
  const rpcUrl = asString(env.CLAWD_ZK_RPC_URL, "");
  if (!rpcUrl) {
    throw new Error(
      "CLAWD_ZK_RPC_URL is not set. Add it to ~/.clawd-code/.env (or pass `rpcUrl` directly to the agent).",
    );
  }
  const programId = resolveProgramId(env.CLAWD_ZK_PROGRAM_ID);
  const photonUrl = asString(env.CLAWD_ZK_PHOTON_URL, rpcUrl);
  return {
    rpcUrl,
    programId,
    photonUrl,
    apiKey: env.CLAWD_ZK_API_KEY || undefined,
    commitment: asCommitment(env.CLAWD_ZK_COMMITMENT),
    keypairPath: env.CLAWD_ZK_KEYPAIR || undefined,
    network: asNetwork(env.CLAWD_ZK_NETWORK),
  };
}
