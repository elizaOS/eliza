/**
 * Cloud wallet provisioning + client-address key management.
 *
 * Gated by ENABLE_CLOUD_WALLET. Every export short-circuits when the flag
 * is off so no cloud code paths run in legacy builds.
 *
 * Responsibilities:
 *   1. Generate + persist ELIZA_CLOUD_CLIENT_ADDRESS_KEY (the local secp256k1
 *      key whose address ties this install to cloud-custodied wallets).
 *   2. Provision EVM + Solana cloud wallets for an agent, guarded by a
 *      single-flight mutex keyed on (agentId, chainType) to prevent duplicate
 *      provision under concurrent cloud-login triggers.
 *   3. Write the resulting descriptors into the in-memory config under
 *      wallet.cloud.{evm,solana}; caller persists via saveConfig().
 */

import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type {
  CloudBridgeError,
  CloudChainType,
  CloudWalletDescriptor,
  CloudWalletProvider,
} from "./bridge-client.js";
import { persistConfigEnv } from "../lib/config-env";
import { isCloudWalletEnabled } from "../lib/feature-flags";

export const ELIZA_CLOUD_CLIENT_ADDRESS_KEY_ENV =
  "ELIZA_CLOUD_CLIENT_ADDRESS_KEY";

export class CloudWalletFlagDisabledError extends Error {
  constructor() {
    super("ENABLE_CLOUD_WALLET is off; cloud wallet code paths are inactive");
    this.name = "CloudWalletFlagDisabledError";
  }
}

function ensureFlag(): void {
  if (!isCloudWalletEnabled()) {
    throw new CloudWalletFlagDisabledError();
  }
}

/**
 * Normalize a hex private key to the 0x-prefixed form viem expects.
 */
function normalizePrivateKey(raw: string): `0x${string}` {
  const trimmed = raw.trim();
  const hex = trimmed.startsWith("0x") ? trimmed.slice(2) : trimmed;
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(
      `Malformed ${ELIZA_CLOUD_CLIENT_ADDRESS_KEY_ENV}: expected 32-byte hex`,
    );
  }
  return `0x${hex.toLowerCase()}`;
}

export interface GetOrCreateKeyOptions {
  /** Override state dir for config.env persistence. Used by tests. */
  stateDir?: string;
}

export interface CloudWalletProvisionBridge {
  getAgentWallet(
    agentId: string,
    chain: CloudChainType,
  ): Promise<CloudWalletDescriptor>;
  provisionWallet(input: {
    chainType: CloudChainType;
    clientAddress: string;
  }): Promise<{
    walletId: string;
    address: string;
    chainType: CloudChainType;
    provider: CloudWalletProvider;
  }>;
}

/**
 * Read or mint the local client-address secp256k1 key.
 *
 * Priority:
 *   1. process.env[ELIZA_CLOUD_CLIENT_ADDRESS_KEY] — respected as-is.
 *   2. Generate a fresh key, write to `process.env` AND disk (`config.env`)
 *      so it survives restart.
 *
 * The key is in `BLOCKED_STARTUP_ENV_KEYS` so it never syncs into
 * `eliza.json` — `config.env` is the designated disk home for it.
 */
export async function getOrCreateClientAddressKey(
  opts: GetOrCreateKeyOptions = {},
): Promise<{
  privateKey: `0x${string}`;
  address: `0x${string}`;
  minted: boolean;
}> {
  ensureFlag();

  const existing = process.env[ELIZA_CLOUD_CLIENT_ADDRESS_KEY_ENV];
  if (existing && existing.trim().length > 0) {
    const privateKey = normalizePrivateKey(existing);
    const account = privateKeyToAccount(privateKey);
    return { privateKey, address: account.address, minted: false };
  }

  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);

  process.env[ELIZA_CLOUD_CLIENT_ADDRESS_KEY_ENV] = privateKey;
  await persistConfigEnv(ELIZA_CLOUD_CLIENT_ADDRESS_KEY_ENV, privateKey, {
    stateDir: opts.stateDir,
  });

  return { privateKey, address: account.address, minted: true };
}

// ---------------------------------------------------------------------------
// Single-flight provisioning
// ---------------------------------------------------------------------------

const inflight = new Map<string, Promise<CloudWalletDescriptor>>();

function inflightKey(agentId: string, chain: CloudChainType): string {
  return `${agentId}::${chain}`;
}

async function provisionOne(
  bridge: CloudWalletProvisionBridge,
  agentId: string,
  chain: CloudChainType,
  clientAddress: string,
): Promise<CloudWalletDescriptor> {
  try {
    return await bridge.getAgentWallet(agentId, chain);
  } catch (error) {
    if (!isMissingCloudWalletError(error, chain)) {
      throw error;
    }
  }

  const provisioned = await bridge.provisionWallet({
    chainType: chain,
    clientAddress,
  });

  return {
    agentWalletId: provisioned.walletId,
    walletAddress: provisioned.address,
    walletProvider: provisioned.provider,
    chainType: chain,
  };
}

function isMissingCloudWalletError(
  error: unknown,
  chain: CloudChainType,
): boolean {
  if (
    error instanceof Error &&
    new RegExp(`no cloud ${chain} wallet provisioned`, "i").test(error.message)
  ) {
    return true;
  }

  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === "CloudBridgeError" &&
    typeof (error as CloudBridgeError).status === "number" &&
    (error as CloudBridgeError).status === 404
  );
}

export interface ProvisionOptions {
  agentId: string;
  clientAddress: string;
  chains?: CloudChainType[];
}

export interface CloudWalletDescriptors {
  evm: CloudWalletDescriptor;
  solana: CloudWalletDescriptor;
}

export interface CloudWalletProvisionFailure {
  chain: CloudChainType;
  error: unknown;
}

export interface CloudWalletProvisionResult {
  descriptors: Partial<CloudWalletDescriptors>;
  failures: CloudWalletProvisionFailure[];
  warnings: string[];
}

function formatProvisionWarning(chain: CloudChainType, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `Cloud ${chain} wallet import failed: ${message}`;
}

/**
 * Provision EVM + Solana cloud wallets idempotently.
 *
 * Concurrent callers for the same (agentId, chain) share a single in-flight
 * promise so we never send duplicate provision requests.
 */
export async function provisionCloudWalletsBestEffort(
  bridge: CloudWalletProvisionBridge,
  opts: ProvisionOptions,
): Promise<CloudWalletProvisionResult> {
  ensureFlag();

  const chains: CloudChainType[] = opts.chains ?? ["evm", "solana"];

  const results = await Promise.all(
    chains.map((chain) => {
      const key = inflightKey(opts.agentId, chain);
      const pending = inflight.get(key);
      if (pending) {
        return pending.then(
          (descriptor) =>
            ({
              chain,
              ok: true as const,
              descriptor,
            }) as const,
          (error) =>
            ({
              chain,
              ok: false as const,
              error,
            }) as const,
        );
      }

      const p = provisionOne(
        bridge,
        opts.agentId,
        chain,
        opts.clientAddress,
      ).finally(() => {
        inflight.delete(key);
      });
      inflight.set(key, p);
      return p.then(
        (descriptor) =>
          ({
            chain,
            ok: true as const,
            descriptor,
          }) as const,
        (error) =>
          ({
            chain,
            ok: false as const,
            error,
          }) as const,
      );
    }),
  );

  const out: Partial<CloudWalletDescriptors> = {};
  const failures: CloudWalletProvisionFailure[] = [];
  for (const result of results) {
    if ("descriptor" in result) {
      out[result.chain] = result.descriptor;
      continue;
    }
    failures.push({ chain: result.chain, error: result.error });
  }

  return {
    descriptors: out,
    failures,
    warnings: failures.map(({ chain, error }) =>
      formatProvisionWarning(chain, error),
    ),
  };
}

export async function provisionCloudWallets(
  bridge: CloudWalletProvisionBridge,
  opts: ProvisionOptions,
): Promise<Partial<CloudWalletDescriptors>> {
  const result = await provisionCloudWalletsBestEffort(bridge, opts);
  if (
    result.failures.length > 0 &&
    Object.keys(result.descriptors).length === 0
  ) {
    const firstFailure = result.failures[0];
    if (firstFailure?.error instanceof Error) {
      throw firstFailure.error;
    }
    throw new Error(result.warnings[0] ?? "Failed to provision cloud wallets");
  }

  return result.descriptors;
}

// ---------------------------------------------------------------------------
// Config cache write
// ---------------------------------------------------------------------------

export interface CloudWalletCacheTarget {
  wallet?: {
    cloud?: Partial<Record<CloudChainType, CloudWalletDescriptor>>;
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

/**
 * Write the descriptors into the provided config object under
 * `wallet.cloud.{evm,solana}`. Caller is responsible for persisting
 * (state.saveConfig()).
 */
export function persistCloudWalletCache(
  config: CloudWalletCacheTarget,
  descriptors: Partial<CloudWalletDescriptors>,
): void {
  ensureFlag();

  const wallet = (config.wallet ?? {}) as NonNullable<
    CloudWalletCacheTarget["wallet"]
  >;
  const cloud = { ...(wallet.cloud ?? {}) };
  if (descriptors.evm) cloud.evm = descriptors.evm;
  if (descriptors.solana) cloud.solana = descriptors.solana;
  wallet.cloud = cloud;
  config.wallet = wallet;
}

// ---------------------------------------------------------------------------
// Test hooks
// ---------------------------------------------------------------------------

/** @internal — exposed for tests to reset state between cases. */
export function __resetCloudWalletModuleForTests(): void {
  inflight.clear();
  delete process.env[ELIZA_CLOUD_CLIENT_ADDRESS_KEY_ENV];
}
