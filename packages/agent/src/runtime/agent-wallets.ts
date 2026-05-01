/**
 * Per-agent wallet keys, stored in the Eliza vault.
 *
 * This module is the bridge between agent identity and the vault. Each
 * agent gets its own EVM and Solana keypair, stored under
 * `agent.<agentId>.wallet.<chain>` as a JSON record. Private keys are
 * sensitive and AES-GCM encrypted at rest by the vault; the vault's
 * master key lives in the OS keychain.
 *
 * The runtime-wide single wallet (process.env.EVM_PRIVATE_KEY etc.) is
 * the *user* wallet, hydrated from the OS secure store via
 * `hydrateWalletKeysFromNodePlatformSecureStore`. Per-agent wallets are
 * stored *inside* the vault (encrypted file), enumerable and easy to
 * surface in the UI alongside saved logins.
 *
 * This module does not generate or store keys on its own; callers
 * supply a `Vault` instance. Agent-creation lifecycle code wires this
 * up — see `runtime/eliza.ts`.
 */

import { removeEntryMeta, setEntryMeta, type Vault } from "@elizaos/vault";
import { deriveEvmAddress, generateWalletForChain } from "../api/wallet.js";
import type { WalletChain } from "../contracts/wallet.js";

const PREFIX = "agent";
const SEGMENT = "wallet";

/** Public, non-sensitive description of an agent wallet. */
export interface AgentWalletDescriptor {
  readonly agentId: string;
  readonly chain: WalletChain;
  readonly address: string;
  readonly lastModified: number;
}

/** Stored shape inside the vault. Sensitive — never log or surface raw. */
interface StoredAgentWallet {
  readonly chain: WalletChain;
  readonly address: string;
  readonly privateKey: string;
  readonly lastModified: number;
}

function encodeAgentSegment(agentId: string): string {
  if (typeof agentId !== "string" || agentId.trim().length === 0) {
    throw new TypeError("agent-wallets: agentId must be a non-empty string");
  }
  // encodeURIComponent leaves `.` alone, but our vault keys split on `.`
  // — escape it explicitly so an agent ID like "alice.bob" doesn't bleed
  // into the layout (`agent.alice.bob.wallet.evm` has five parts, not four).
  return encodeURIComponent(agentId.trim()).replace(/\./g, "%2E");
}

function decodeAgentSegment(segment: string): string {
  return decodeURIComponent(segment);
}

function walletKey(agentId: string, chain: WalletChain): string {
  return `${PREFIX}.${encodeAgentSegment(agentId)}.${SEGMENT}.${chain}`;
}

function agentPrefix(agentId: string): string {
  return `${PREFIX}.${encodeAgentSegment(agentId)}.${SEGMENT}`;
}

function parseAgentWalletKey(
  key: string,
): { agentId: string; chain: WalletChain } | null {
  // Layout: agent.<encodedId>.wallet.<chain>
  const parts = key.split(".");
  if (parts.length !== 4) return null;
  if (parts[0] !== PREFIX || parts[2] !== SEGMENT) return null;
  const encodedAgentId = parts[1];
  if (!encodedAgentId) return null;
  const chain = parts[3];
  if (chain !== "evm" && chain !== "solana") return null;
  return { agentId: decodeAgentSegment(encodedAgentId), chain };
}

function parseStored(raw: string): StoredAgentWallet {
  const parsed = JSON.parse(raw) as Partial<StoredAgentWallet>;
  if (
    (parsed.chain !== "evm" && parsed.chain !== "solana") ||
    typeof parsed.address !== "string" ||
    typeof parsed.privateKey !== "string" ||
    typeof parsed.lastModified !== "number"
  ) {
    throw new Error(
      "agent-wallets: stored entry malformed (expected chain/address/privateKey/lastModified)",
    );
  }
  return {
    chain: parsed.chain,
    address: parsed.address,
    privateKey: parsed.privateKey,
    lastModified: parsed.lastModified,
  };
}

/**
 * Derive the public address from a stored private key. EVM uses the
 * existing helper; Solana stores the public key alongside the secret in
 * `generateWalletForChain`, so the stored `address` is authoritative
 * and we trust it for the read path.
 */
function deriveAddressFor(chain: WalletChain, privateKey: string): string {
  if (chain === "evm") return deriveEvmAddress(privateKey);
  // For Solana the keypair format already includes the public key; the
  // caller is expected to have stored the public key as `address` at
  // write time. Re-derivation would require @solana/web3.js, which we
  // avoid pulling in here.
  throw new Error(
    "agent-wallets: deriveAddressFor only supports EVM; Solana addresses must be supplied at write time",
  );
}

/**
 * Read the public descriptor for an agent's wallet. Returns null when
 * the agent has no wallet for that chain. Does NOT reveal the private
 * key.
 */
export async function getAgentWalletDescriptor(
  vault: Vault,
  agentId: string,
  chain: WalletChain,
): Promise<AgentWalletDescriptor | null> {
  const key = walletKey(agentId, chain);
  if (!(await vault.has(key))) return null;
  const raw = await vault.get(key);
  const stored = parseStored(raw);
  return {
    agentId,
    chain,
    address: stored.address,
    lastModified: stored.lastModified,
  };
}

/**
 * Reveal the private key. Audit-logged via the vault. Use only for
 * signing flows.
 */
export async function revealAgentWalletPrivateKey(
  vault: Vault,
  agentId: string,
  chain: WalletChain,
  caller?: string,
): Promise<string> {
  const key = walletKey(agentId, chain);
  const raw = await vault.reveal(key, caller);
  return parseStored(raw).privateKey;
}

/**
 * Existence check. Does not reveal the key.
 */
export async function hasAgentWallet(
  vault: Vault,
  agentId: string,
  chain: WalletChain,
): Promise<boolean> {
  return vault.has(walletKey(agentId, chain));
}

/**
 * List every wallet descriptor for an agent (typically [evm, solana]).
 */
export async function listAgentWallets(
  vault: Vault,
  agentId: string,
): Promise<readonly AgentWalletDescriptor[]> {
  const keys = await vault.list(agentPrefix(agentId));
  const out: AgentWalletDescriptor[] = [];
  for (const key of keys) {
    const parsed = parseAgentWalletKey(key);
    if (!parsed) continue;
    const raw = await vault.get(key);
    const stored = parseStored(raw);
    out.push({
      agentId: parsed.agentId,
      chain: parsed.chain,
      address: stored.address,
      lastModified: stored.lastModified,
    });
  }
  return out;
}

/**
 * List every agent that has at least one wallet stored. Returns the
 * agent IDs (decoded). Use for UI surfaces enumerating agent wallets.
 */
export async function listAgentsWithWallets(
  vault: Vault,
): Promise<readonly string[]> {
  const keys = await vault.list(PREFIX);
  const agents = new Set<string>();
  for (const key of keys) {
    const parsed = parseAgentWalletKey(key);
    if (!parsed) continue;
    agents.add(parsed.agentId);
  }
  return [...agents];
}

/**
 * Persist a wallet for an agent. Replaces any existing entry for that
 * (agentId, chain). Stamps `lastModified`.
 *
 * Caller is responsible for supplying the matching address — for EVM
 * this can be derived from the private key, for Solana the keypair
 * generator returns it directly.
 */
export async function setAgentWallet(
  vault: Vault,
  agentId: string,
  chain: WalletChain,
  privateKey: string,
  address: string,
  caller?: string,
): Promise<AgentWalletDescriptor> {
  if (typeof privateKey !== "string" || privateKey.trim().length === 0) {
    throw new TypeError("agent-wallets: privateKey required");
  }
  if (typeof address !== "string" || address.trim().length === 0) {
    throw new TypeError("agent-wallets: address required");
  }
  const stored: StoredAgentWallet = {
    chain,
    address,
    privateKey,
    lastModified: Date.now(),
  };
  const key = walletKey(agentId, chain);
  await vault.set(key, JSON.stringify(stored), {
    sensitive: true,
    ...(caller ? { caller } : {}),
  });
  // Surface per-agent wallets in Settings → Vault → Secrets under the
  // "Wallet" group. Without explicit meta, the inventory categorizer
  // falls back to "plugin" for the `agent.<id>.wallet.<chain>` shape.
  await setEntryMeta(vault, key, {
    category: "wallet",
    label: `agent ${agentId} (${chain})`,
  });
  return {
    agentId,
    chain,
    address: stored.address,
    lastModified: stored.lastModified,
  };
}

/**
 * Generate a fresh wallet for an agent and persist it. Returns the
 * public descriptor. Idempotent: callers should check `hasAgentWallet`
 * first if they want to avoid replacing an existing wallet.
 */
export async function generateAgentWallet(
  vault: Vault,
  agentId: string,
  chain: WalletChain,
  caller?: string,
): Promise<AgentWalletDescriptor> {
  const generated = generateWalletForChain(chain);
  return setAgentWallet(
    vault,
    agentId,
    chain,
    generated.privateKey,
    generated.address,
    caller,
  );
}

/**
 * Generate any missing wallets (EVM + Solana) for an agent. Existing
 * wallets are left alone. Returns descriptors for every chain that now
 * has a wallet (whether it was generated this call or was already
 * present).
 */
export async function ensureAgentWallets(
  vault: Vault,
  agentId: string,
  caller?: string,
): Promise<readonly AgentWalletDescriptor[]> {
  const chains: WalletChain[] = ["evm", "solana"];
  const out: AgentWalletDescriptor[] = [];
  for (const chain of chains) {
    const existing = await getAgentWalletDescriptor(vault, agentId, chain);
    if (existing) {
      out.push(existing);
      continue;
    }
    out.push(await generateAgentWallet(vault, agentId, chain, caller));
  }
  return out;
}

/**
 * Remove an agent's wallet for one chain. Idempotent.
 */
export async function removeAgentWallet(
  vault: Vault,
  agentId: string,
  chain: WalletChain,
): Promise<void> {
  const key = walletKey(agentId, chain);
  await vault.remove(key);
  await removeEntryMeta(vault, key);
}

/**
 * Remove every wallet for an agent. Use during agent deletion.
 */
export async function removeAllAgentWallets(
  vault: Vault,
  agentId: string,
): Promise<void> {
  const wallets = await listAgentWallets(vault, agentId);
  for (const w of wallets) {
    await removeAgentWallet(vault, agentId, w.chain);
  }
}

// Internal helpers — exported for tests only.
export const __test__ = {
  walletKey,
  agentPrefix,
  parseAgentWalletKey,
  deriveAddressFor,
};
