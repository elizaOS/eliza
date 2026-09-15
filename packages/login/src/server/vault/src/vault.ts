import { createHash, randomUUID } from "node:crypto";
import { logger } from "@elizaos/logger";
import bs58 from "bs58";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  type Chain,
  createPublicClient,
  createWalletClient,
  formatEther,
  http,
  type TransactionSerializable,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  arbitrum,
  base,
  baseSepolia,
  bsc,
  bscTestnet,
  gnosis,
  mainnet,
  polygon,
} from "viem/chains";
import { requireLoginValue } from "../../../required";
import {
  agents,
  agentWallets,
  encryptedChainKeys,
  encryptedKeys,
  getDb,
  policies,
  toAgentIdentity,
  transactions,
} from "../../db/src/index.ts";
import type {
  AgentIdentity,
  BitcoinAddressType,
  BitcoinNetwork,
  ChainFamily,
  MoneroNetwork,
  PolicyResult,
  RpcRequest,
  RpcResponse,
  SignRequest,
  SignSolanaTransactionRequest,
  SignTypedDataRequest,
  TxStatus,
  WalletAddressMetadata,
} from "../../shared/src/index.ts";
import { canonicalJsonStringify, toCaip2 } from "../../shared/src/index.ts";
import {
  type BitcoinPsbtOutput,
  type SignBitcoinPsbtResult as BitcoinPsbtSignerResult,
  inspectBitcoinPsbt as inspectBitcoinPsbtPayload,
  parseBitcoinPsbtSigningMetadata,
  signBitcoinPsbt,
} from "./bitcoin-psbt";
import {
  allocateEvmNonce,
  confirmEvmNonce,
  markEvmNonceDropped,
} from "./evm-nonce-manager";
import {
  assertExternalKeyCustodyProviderV1,
  assertNoExternalPrivateKeyMaterial,
  ExternalBroadcastOutcomeUnknownError,
  type ExternalKeyCustodyProvider,
  type ExternalKeyHandleImportRequest,
  type ExternalKeyHandleRegistration,
  type ExternalKeySigningAvailability,
  externalKeyCustodyUnavailableError,
  externalKeyPrivateExportUnavailableError,
  externalKeySigningUnavailableError,
  normalizeExternalKeyHandleRegistration,
  SolanaBroadcastNotSubmittedError,
} from "./external-key-custody";
import {
  deriveBitcoinKey,
  deriveEvmKey,
  deriveSolanaKey,
  generateMnemonic,
} from "./hd-wallet";
import { type EncryptedKey, KeyStore } from "./keystore";
import { backendFromKeyStore, type KeystoreBackend } from "./keystore-backend";
import { executeLocalEvmBroadcast } from "./local-evm-broadcast";
import {
  createMoneroBackendFromEnv,
  generateMoneroWallet,
  type MoneroBalanceResult,
  type MoneroKeyPayloadV1,
  MoneroNotConfiguredError,
  type MoneroWalletBackend,
  moneroPublicMetadataFromPayload,
  moneroWalletScope,
  parseMoneroKeyPayload,
  parseMoneroWalletScope,
  parsePiconeroAmount,
  serializeMoneroKeyPayload,
} from "./monero";
import { assertVaultSigningActive } from "./signing-freeze";
import {
  assertSolanaTransferTransactionMatches,
  buildSolanaSplTransferTransaction as buildSolanaSplTransferTx,
  getSplTokenBalances as fetchSplTokenBalances,
  generateSolanaKeypair,
  getSolanaBalance,
  restoreSolanaKeypair,
  type SolanaSplTransferTransaction,
  type SplTokenBalance,
  signEd25519Digest,
  signSolanaMessage,
  signSolanaTransaction,
} from "./solana";
import {
  assertParsedSolanaTransferMatches,
  assertSolanaPriorityFeeWithinCap,
  isVersionedTransactionBytes,
  parseSolanaTransaction,
} from "./solana-instructions";
import {
  getTokenBalances as fetchTokenBalances,
  type TokenBalance,
} from "./tokens";
import {
  ENTRY_POINT_V07,
  getUserOperationHash,
  packUserOperation,
  type UnpackedUserOperationFields,
} from "./userop";

export interface VaultConfig {
  masterPassword: string;
  rpcUrl?: string;
  chainId?: number;
  keystoreBackend?: KeystoreBackend;
  externalKeyCustodyProvider?: ExternalKeyCustodyProvider;
  /**
   * Monero wallet backend. When omitted, the vault builds one lazily from
   * STEWARD_MONERO_* env config; Monero entry points fail closed when neither
   * is available.
   */
  moneroBackend?: MoneroWalletBackend;
}

/**
 * Explicit, logged authorization required to call exportPrivateKey. Forces the
 * caller to opt into a break-glass plaintext-key export rather than invoking it
 * casually; actorId/reason are surfaced in the vault's audit log line.
 */
export interface ExportPrivateKeyAuthorization {
  breakGlass: true;
  actorId: string;
  reason?: string;
}

export interface BitcoinPrivateKeyExport {
  privateKey: string;
  address: string;
  venue: string | null;
  purpose: string | null;
  metadata: WalletAddressMetadata;
}

export interface MoneroPrivateKeyExport {
  /** Private spend key (sufficient to restore the wallet anywhere). */
  spendKey: string;
  /** Private view key. */
  viewKey: string;
  address: string;
  restoreHeight: number;
  venue: string | null;
  purpose: string | null;
  metadata: WalletAddressMetadata;
}

export interface ExportPrivateKeyResult {
  evm?: { privateKey: string; address: string };
  solana?: { privateKey: string; address: string };
  bitcoin?: BitcoinPrivateKeyExport[];
  monero?: MoneroPrivateKeyExport[];
}

export interface SignBitcoinPsbtRequest {
  tenantId: string;
  agentId: string;
  walletScope: string;
  psbtBase64: string;
  finalize?: boolean;
  /**
   * SEC-163: explicit caller attestation that edge policy (inspectBitcoinPsbt
   * + spend/fee evaluation) approved this PSBT. The vault layer performs no
   * fee/output policy of its own — it signs any PSBT with ≥1 input spendable
   * by the wallet key — so signing REQUIRES this flag. Never forward
   * client-controlled input into it.
   */
  allowBlindSign?: boolean;
}

export interface InspectBitcoinPsbtResult {
  walletScope: string;
  walletAddress: string;
  network: BitcoinNetwork;
  outputs: Array<BitcoinPsbtOutput & { isChange: boolean }>;
  inputTotalSats: string;
  outputTotalSats: string;
  feeSats: string;
}

export interface SignBitcoinPsbtResult extends BitcoinPsbtSignerResult {
  walletScope: string;
  walletAddress: string;
}

export interface MoneroCreateOptions {
  network?: MoneroNetwork;
  /** Only account 0 is supported today; the scope format reserves room for more. */
  account?: number;
}

export interface GetMoneroBalanceRequest {
  tenantId: string;
  agentId: string;
  walletScope: string;
}

export interface GetMoneroBalanceResult extends MoneroBalanceResult {
  walletScope: string;
  walletAddress: string;
  network: MoneroNetwork;
}

export interface PrepareMoneroTransferRequest {
  tenantId: string;
  agentId: string;
  walletScope: string;
  destinations: Array<{ address: string; amountPiconero: string }>;
  /** wallet2 fee priority, 0 (default) .. 3 (elevated). */
  priority?: number;
}

export interface PrepareMoneroTransferResult {
  walletScope: string;
  walletAddress: string;
  network: MoneroNetwork;
  /** Signed-but-unrelayed tx blob. Keep in memory only; relay or discard. */
  txMetadata: string;
  txHash: string;
  feePiconero: bigint;
  amountPiconero: bigint;
}

export interface RelayMoneroTransferRequest {
  tenantId: string;
  agentId: string;
  walletScope: string;
  txMetadata: string;
}

const CHAINS: Record<number, Chain> = {
  1: mainnet, // Ethereum
  56: bsc, // BSC
  97: bscTestnet, // BSC Testnet
  100: gnosis, // Gnosis
  137: polygon, // Polygon
  8453: base, // Base
  42161: arbitrum, // Arbitrum
  84532: baseSepolia, // Base Sepolia
};

// Default public RPC URLs per EVM chain (override with env / VaultConfig.rpcUrl for the active chain)
const CHAIN_RPCS: Record<number, string> = {
  1: "https://eth.llamarpc.com",
  56: "https://bsc-dataseed.binance.org",
  97: "https://data-seed-prebsc-1-s1.bnbchain.org:8545",
  100: "https://rpc.gnosischain.com",
  137: "https://polygon-rpc.com",
  8453: "https://mainnet.base.org",
  42161: "https://arb1.arbitrum.io/rpc",
  84532: "https://sepolia.base.org",
};

// Solana RPC URLs (chainId 101 = mainnet-beta, 102 = devnet)
const SOLANA_RPCS: Record<number, string> = {
  101: "https://api.mainnet-beta.solana.com",
  102: "https://api.devnet.solana.com",
};

/**
 * SEC-082: default read-only method inventory for rpcPassthrough. Anything not
 * listed here is rejected — signing, state-modifying, and operator-namespace
 * methods (eth_sendTransaction, eth_sign*, personal_*, Solana sendTransaction/
 * signMessage/signTransaction/requestAirdrop, eth_accounts, admin_/debug_/
 * trace_/txpool_/miner_*) can never be proxied, regardless of the upstream.
 * STEWARD_VAULT_RPC_ALLOWLIST may only tighten this inventory (fail closed).
 */
const DEFAULT_RPC_PASSTHROUGH_ALLOWLIST = [
  // EVM read-only
  "eth_chainId",
  "eth_blockNumber",
  "eth_getBalance",
  "eth_getCode",
  "eth_getStorageAt",
  "eth_getTransactionCount",
  "eth_getTransactionByHash",
  "eth_getTransactionReceipt",
  "eth_getBlockByNumber",
  "eth_getBlockByHash",
  "eth_getBlockTransactionCountByNumber",
  "eth_getBlockTransactionCountByHash",
  "eth_getBlockReceipts",
  "eth_getLogs",
  "eth_getProof",
  "eth_call",
  "eth_estimateGas",
  "eth_gasPrice",
  "eth_maxPriorityFeePerGas",
  "eth_feeHistory",
  "eth_syncing",
  "net_version",
  "net_listening",
  "net_peerCount",
  "web3_clientVersion",
  // Solana read-only
  "getBalance",
  "getAccountInfo",
  "getMultipleAccounts",
  "getBlock",
  "getBlocks",
  "getBlocksWithLimit",
  "getBlockHeight",
  "getBlockTime",
  "getLatestBlockhash",
  "isBlockhashValid",
  "getFeeForMessage",
  "getTransaction",
  "getSignaturesForAddress",
  "getSignatureStatuses",
  "getTokenAccountsByOwner",
  "getTokenAccountBalance",
  "getTokenSupply",
  "getProgramAccounts",
  "getSupply",
  "getSlot",
  "getVersion",
  "getHealth",
  "getEpochInfo",
  "getEpochSchedule",
  "getGenesisHash",
  "getRecentPrioritizationFees",
  "getMinimumBalanceForRentExemption",
  "getStakeMinimumDelegation",
  "minimumLedgerSlot",
  "simulateTransaction",
];
const DEFAULT_RPC_PASSTHROUGH_METHODS = new Set(
  DEFAULT_RPC_PASSTHROUGH_ALLOWLIST,
);
const RPC_PASSTHROUGH_TIMEOUT_MS = 10_000;
const RPC_PASSTHROUGH_MAX_RESPONSE_BYTES = 1024 * 1024;

async function readBoundedRpcResponse(
  response: Response,
): Promise<RpcResponse> {
  if (!response.ok) {
    void response.body?.cancel().catch(() => {});
    throw new Error(`RPC request failed with status ${response.status}`);
  }
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    const length = Number(declared);
    if (
      !Number.isSafeInteger(length) ||
      length < 0 ||
      length > RPC_PASSTHROUGH_MAX_RESPONSE_BYTES
    ) {
      void response.body?.cancel().catch(() => {});
      throw new Error("RPC response exceeded maximum size");
    }
  }
  if (!response.body) throw new Error("RPC response was empty");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > RPC_PASSTHROUGH_MAX_RESPONSE_BYTES) {
        void reader.cancel().catch(() => {});
        throw new Error("RPC response exceeded maximum size");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error("RPC response was malformed");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("RPC response was malformed");
  }
  return parsed as RpcResponse;
}

export function resolveSignVenueSelector(
  request: Pick<SignRequest, "venue">,
): string | null {
  return request.venue ?? null;
}

export function missingSigningKeyError(
  agentId: string,
  chainFamily: string,
  venue?: string | null,
): Error {
  const venueSuffix = venue ? ` with venue ${venue}` : "";
  return new Error(
    `No signing key found for agent ${agentId} on chain family ${chainFamily}${venueSuffix}`,
  );
}

export function assertEvmWalletAddressMatches(
  secretKey: string,
  walletAddress?: string,
): void {
  if (!walletAddress) return;
  const derivedAddress = privateKeyToAccount(
    secretKey as `0x${string}`,
  ).address;
  if (derivedAddress.toLowerCase() !== walletAddress.toLowerCase()) {
    throw new Error(
      `Wallet address mismatch: resolved ${derivedAddress} but request specified ${walletAddress}`,
    );
  }
}

/**
 * Detect chain type from wallet address format.
 * EVM addresses start with "0x"; Solana addresses are base58 (no "0x" prefix).
 */
function detectChainType(walletAddress: string): "evm" | "solana" {
  return walletAddress.startsWith("0x") ? "evm" : "solana";
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

/**
 * Resolve the Solana RPC URL for a given convention chainId (101/102).
 * Falls back to mainnet-beta if the chainId isn't recognised.
 */
function resolveSolanaRpc(chainId?: number): string {
  return SOLANA_RPCS[chainId ?? 101] ?? SOLANA_RPCS[101];
}

export interface SignTransactionOptions {
  txId?: string;
  policyResults?: PolicyResult[];
  status?: TxStatus;
  /**
   * The custody backend the caller's authorization is cryptographically bound
   * to (set by the governed execution-gateway path to "local-vault"). When
   * present, {@link Vault.signTransaction} RE-RESOLVES the backend from the SAME
   * fresh wallet lookup it will actually sign with and asserts it matches this
   * bound backend BEFORE routing to any provider. This closes the
   * resolveExecutionBackend -> sign TOCTOU: if the wallet's backend flips (a
   * local key is removed and an third-party-custody key inserted) between the
   * gateway's precheck and the raw sign, a local-vault-bound authorization can
   * no longer reach the third-party provider. External custody always
   * requires this binding; absent (undefined) remains valid only for legacy
   * local-vault callers.
   */
  expectedBackend?: "local-vault" | "external-custody";
  expectedBackendIdentityDigest?: string;
}

export interface ResolvedExecutionTarget {
  backend: "local-vault" | "external-custody";
  backendIdentityDigest?: string;
}

export function externalCustodyIdentityDigest(input: {
  providerId: string;
  keyId: string;
  version?: string;
  region?: string;
  address: string;
}): string {
  return createHash("sha256")
    .update(
      canonicalJsonStringify({
        providerId: input.providerId,
        keyId: input.keyId,
        version: input.version ?? null,
        region: input.region ?? null,
        address: input.address.toLowerCase(),
      }),
    )
    .digest("hex");
}

/**
 * Thrown when a governed (gateway-authorized) sign request that is bound to a
 * specific custody backend re-resolves at signing time to a DIFFERENT backend.
 * The gateway mints authorizations bound to "local-vault"; if the wallet has
 * since flipped to third-party custody, the raw signer fails closed here before
 * any third-party provider is reached (audited, fund-loss-safe).
 */
export class BackendBindingMismatchError extends Error {
  readonly code: "backend_binding_mismatch" | "backend_identity_mismatch";
  constructor(
    readonly expectedBackend: "local-vault" | "external-custody",
    readonly resolvedBackend: "local-vault" | "external-custody",
    readonly identityChanged = false,
  ) {
    super(
      identityChanged
        ? "External custody provider/key/address identity changed after authorization"
        : `Execution backend binding mismatch: authorization is bound to ` +
            `"${expectedBackend}" but the wallet re-resolved to "${resolvedBackend}" ` +
            `at signing time. Refusing to route a ${expectedBackend}-bound ` +
            `authorization across custody backends.`,
    );
    this.code = identityChanged
      ? "backend_identity_mismatch"
      : "backend_binding_mismatch";
    this.name = "BackendBindingMismatchError";
  }
}

/**
 * Lock scope for custody-affecting writes (importKey / importExternalKeyHandle):
 * one (agent, chain family, venue) tuple. importKey always operates on the
 * venue-less scope, matching the legacy/unscoped key rows it writes.
 */
function custodyTransitionLockKey(
  tenantId: string,
  agentId: string,
  chainFamily: string,
  venue: string | null,
): string {
  // JSON array encoding preserves tuple boundaries even when operator-defined
  // ids/venues contain colons. Include tenant identity explicitly rather than
  // relying on the current globally-unique agent-id schema forever.
  return JSON.stringify([
    "vault-custody-v1",
    tenantId,
    agentId,
    chainFamily,
    venue,
  ]);
}

/**
 * PGlite (tests, desktop mode) is a single-connection harness where
 * transactions already serialize; the repo convention is to skip advisory
 * locks there. Production Postgres takes the xact lock so concurrent custody
 * transitions across replicas/connections cannot interleave check-then-act.
 */
function usesCustodyAdvisoryLock(): boolean {
  return (
    process.env.STEWARD_DB_MODE !== "pglite" &&
    process.env.STEWARD_PGLITE_MEMORY !== "true"
  );
}

interface MnemonicWalletMaterial {
  evmPrivateKey: `0x${string}`;
  evmAddress: string;
  solanaSecretHex: string;
  solanaAddress: string;
}

export interface RestoreAgentFromMnemonicResult extends AgentIdentity {
  restoredExisting: boolean;
}

type WalletChainFamily = ChainFamily;

interface BitcoinCreateOptions {
  network?: BitcoinNetwork;
  addressType?: BitcoinAddressType;
  account?: number;
  change?: 0 | 1;
  index?: number;
}

interface WalletRowResult {
  agentId: string;
  chainFamily: WalletChainFamily;
  venue: string | null;
  purpose: string | null;
  address: string;
  metadata: Record<string, unknown>;
}

interface ExternalKeyWalletMetadata extends Record<string, unknown> {
  custody: "external";
  externalKey: {
    providerId: string;
    keyId: string;
    version?: string;
    region?: string;
    registeredAt: string;
    exportablePrivateKey: false;
    signingAvailability: ExternalKeySigningAvailability;
    providerMetadata?: Record<string, unknown>;
  };
}

function bitcoinCaip2(network: BitcoinNetwork): string {
  return network === "mainnet"
    ? "bip122:000000000019d6689c085ae165831e93"
    : "bip122:000000000933ea01ad0ee984209779ba";
}

function bitcoinWalletScope(options: Required<BitcoinCreateOptions>): string {
  return `bitcoin:${options.network}:${options.addressType}:${options.account}:${options.change}:${options.index}`;
}

function isExternalKeyWalletMetadata(
  value: unknown,
): value is ExternalKeyWalletMetadata {
  if (!value || typeof value !== "object") return false;
  const metadata = value as Record<string, unknown>;
  return (
    metadata.custody === "external" && typeof metadata.externalKey === "object"
  );
}

function toExternalKeyWalletMetadata(
  registration: ExternalKeyHandleRegistration,
): ExternalKeyWalletMetadata {
  const metadata: ExternalKeyWalletMetadata = {
    custody: "external",
    externalKey: {
      providerId: registration.handle.providerId,
      keyId: registration.handle.keyId,
      registeredAt: registration.registeredAt.toISOString(),
      exportablePrivateKey: false,
      signingAvailability: registration.signingAvailability,
    },
  };
  if (registration.handle.version)
    metadata.externalKey.version = registration.handle.version;
  if (registration.handle.region)
    metadata.externalKey.region = registration.handle.region;
  if (Object.keys(registration.metadata).length > 0) {
    metadata.externalKey.providerMetadata = registration.metadata;
  }
  assertNoExternalPrivateKeyMaterial(metadata, "walletMetadata");
  return metadata;
}

/**
 * Vault - the core signing service.
 *
 * Manages agent wallets: generates keypairs, stores encrypted private keys,
 * and signs transactions. The private key is decrypted only for the duration
 * of a signing operation and never exposed to agent containers.
 */
export class Vault {
  private keyStore: KeystoreBackend;
  private config: VaultConfig;
  private externalKeyCustodyProvider?: ExternalKeyCustodyProvider;
  private moneroBackend?: MoneroWalletBackend;

  constructor(config: VaultConfig) {
    if (config.externalKeyCustodyProvider) {
      assertExternalKeyCustodyProviderV1(config.externalKeyCustodyProvider);
    }
    this.config = config;
    this.externalKeyCustodyProvider = config.externalKeyCustodyProvider;
    this.moneroBackend = config.moneroBackend;
    // Signing-vault keeps the legacy (undomain) root so existing wallet ciphertext
    // stays decryptable; the SecretVault uses a distinct domain-separated root, so
    // the two roots are cryptographically independent despite sharing masterPassword.
    this.keyStore =
      config.keystoreBackend ??
      backendFromKeyStore(new KeyStore(config.masterPassword));
  }

  /** Resolve the Monero backend, or fail closed when Monero is unconfigured. */
  private getMoneroBackend(): MoneroWalletBackend {
    if (!this.moneroBackend) {
      const backend = createMoneroBackendFromEnv();
      if (!backend) throw new MoneroNotConfiguredError();
      this.moneroBackend = backend;
    }
    return this.moneroBackend;
  }

  /**
   * Stable, non-reversible wallet-cache id for the monero-wallet-rpc sidecar.
   * Only ever derived from identifiers (never key material).
   */
  private moneroCacheId(
    tenantId: string,
    agentId: string,
    walletScope: string,
  ): string {
    return createHash("sha256")
      .update(`${tenantId}\x00${agentId}\x00${walletScope}`)
      .digest("hex");
  }

  /**
   * Load + decrypt the canonical Monero key payload for a scoped wallet.
   * The AAD context MUST byte-match the context used at createWallet time —
   * a drifted context makes the ciphertext permanently undecryptable.
   */
  private async resolveMoneroWallet(args: {
    tenantId: string;
    agentId: string;
    walletScope: string;
  }): Promise<{ payload: MoneroKeyPayloadV1; walletAddress: string }> {
    const { tenantId, agentId, walletScope } = args;
    parseMoneroWalletScope(walletScope);
    const db = getDb();

    const [agentRow] = await db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.tenantId, tenantId)));
    if (!agentRow) {
      throw new Error(`Agent ${agentId} not found for tenant ${tenantId}`);
    }

    const [wallet] = await db
      .select({ address: agentWallets.address })
      .from(agentWallets)
      .where(
        and(
          eq(agentWallets.agentId, agentId),
          eq(agentWallets.chainFamily, "monero"),
          eq(agentWallets.venue, walletScope),
        ),
      );
    if (!wallet) {
      throw missingSigningKeyError(agentId, "monero", walletScope);
    }

    const [chainKey] = await db
      .select()
      .from(encryptedChainKeys)
      .where(
        and(
          eq(encryptedChainKeys.agentId, agentId),
          eq(encryptedChainKeys.chainFamily, "monero"),
          eq(encryptedChainKeys.venue, walletScope),
        ),
      );
    if (!chainKey) {
      throw missingSigningKeyError(agentId, "monero", walletScope);
    }

    const serialized = await this.keyStore.decrypt(
      {
        ciphertext: chainKey.ciphertext,
        iv: chainKey.iv,
        tag: chainKey.tag,
        salt: chainKey.salt,
      },
      { tenantId, agentId, chainFamily: "monero", venue: walletScope },
    );
    const payload = parseMoneroKeyPayload(serialized);
    if (payload.address !== wallet.address) {
      throw new Error(
        "Monero wallet row address does not match the encrypted key payload — refusing to proceed",
      );
    }
    return { payload, walletAddress: wallet.address };
  }

  private async getExternalKeyWallet(args: {
    agentId: string;
    chainFamily: WalletChainFamily;
    venue?: string | null;
  }): Promise<
    | {
        address: string;
        metadata: ExternalKeyWalletMetadata;
      }
    | undefined
  > {
    const db = getDb();
    const [wallet] = await db
      .select({
        address: agentWallets.address,
        metadata: agentWallets.metadata,
      })
      .from(agentWallets)
      .where(
        and(
          eq(agentWallets.agentId, args.agentId),
          eq(agentWallets.chainFamily, args.chainFamily),
          args.venue
            ? eq(agentWallets.venue, args.venue)
            : isNull(agentWallets.venue),
        ),
      );
    if (!wallet || !isExternalKeyWalletMetadata(wallet.metadata))
      return undefined;
    return { address: wallet.address, metadata: wallet.metadata };
  }

  /**
   * Resolve which custody backend a sign request would actually route to,
   * WITHOUT decrypting keys, signing, or calling any third-party provider.
   *
   * This mirrors the exact key-resolution precedence in {@link signTransaction}:
   *   1. A local encrypted chain key (multi-chain table)  -> "local-vault"
   *   2. Otherwise an third-party-custody wallet             -> "third-party-custody"
   *   3. Otherwise a legacy local encrypted key / none     -> "local-vault"
   *
   * ExecutionAuthorizations are bound to a custody backend. An authorization
   * bound to "local-vault" must never authorize third-party custody, so callers
   * resolve this target before minting or consuming authorization.
   */
  async resolveExecutionTarget(request: {
    tenantId: string;
    agentId: string;
    chainId?: number;
    venue?: string | null;
    walletAddress?: string;
  }): Promise<ResolvedExecutionTarget> {
    const db = getDb();
    const chainId = request.chainId || this.config.chainId || 8453;
    const isSolana = chainId === 101 || chainId === 102;
    const chainFamilyToUse: WalletChainFamily = isSolana ? "solana" : "evm";
    const venue = resolveSignVenueSelector({
      venue: request.venue ?? undefined,
    });

    // 1. Local encrypted chain key present -> local vault signs.
    const [chainKey] = await db
      .select({ id: encryptedChainKeys.id })
      .from(encryptedChainKeys)
      .where(
        and(
          eq(encryptedChainKeys.agentId, request.agentId),
          eq(encryptedChainKeys.chainFamily, chainFamilyToUse),
          venue
            ? eq(encryptedChainKeys.venue, venue)
            : isNull(encryptedChainKeys.venue),
        ),
      );
    if (chainKey) return { backend: "local-vault" };

    // 2. No local chain key: an third-party-custody wallet takes precedence in
    //    signTransaction's resolution, so the request would route to the
    //    third-party provider.
    const resolvedWallet = await this.getExternalKeyWallet({
      agentId: request.agentId,
      chainFamily: chainFamilyToUse,
      venue,
    });
    if (resolvedWallet) {
      return {
        backend: "external-custody",
        backendIdentityDigest: externalCustodyIdentityDigest({
          providerId: resolvedWallet.metadata.externalKey.providerId,
          keyId: resolvedWallet.metadata.externalKey.keyId,
          version: resolvedWallet.metadata.externalKey.version,
          region: resolvedWallet.metadata.externalKey.region,
          address: resolvedWallet.address,
        }),
      };
    }

    // 3. No third-party wallet: signTransaction falls back to the legacy local
    //    encrypted_keys table (or throws missing-key). Either way this is a
    //    local-vault backend from the gateway's perspective.
    return { backend: "local-vault" };
  }

  async resolveExecutionBackend(
    request: Parameters<Vault["resolveExecutionTarget"]>[0],
  ): Promise<"local-vault" | "external-custody"> {
    return (await this.resolveExecutionTarget(request)).backend;
  }

  private async assertNoExternalKeyWalletsForExport(
    agentId: string,
  ): Promise<void> {
    const db = getDb();
    const wallets = await db
      .select({ metadata: agentWallets.metadata })
      .from(agentWallets)
      .where(eq(agentWallets.agentId, agentId));
    if (
      wallets.some((wallet) => isExternalKeyWalletMetadata(wallet.metadata))
    ) {
      throw externalKeyPrivateExportUnavailableError();
    }
  }

  private async assertLocalSigningScopeIsNotExternal(
    agentId: string,
    chainFamily: ChainFamily,
    venue: string | null = null,
  ): Promise<void> {
    const externalWallet = await this.getExternalKeyWallet({
      agentId,
      chainFamily,
      venue,
    });
    if (externalWallet) {
      throw new Error(
        "This wallet uses external custody; this signing operation is not supported for external keys",
      );
    }
  }

  private async recordSignedTransaction(
    request: SignRequest,
    chainId: number,
    shouldBroadcast: boolean,
    hash: string,
    options: SignTransactionOptions,
  ): Promise<void> {
    const db = getDb();
    const txId = options.txId ?? crypto.randomUUID();
    const signedAt = new Date();
    const recordedTransactions = await db
      .insert(transactions)
      .values({
        id: txId,
        agentId: request.agentId,
        status: shouldBroadcast ? (options.status ?? "signed") : "signed",
        toAddress: request.to,
        value: request.value,
        data: request.data,
        chainId,
        txHash: shouldBroadcast ? hash : undefined,
        executionBackend: options.expectedBackend,
        executionBackendIdentityDigest: options.expectedBackendIdentityDigest,
        policyResults: options.policyResults ?? [],
        signedAt,
        createdAt: signedAt,
      })
      .onConflictDoUpdate({
        target: transactions.id,
        set: {
          status: shouldBroadcast ? (options.status ?? "signed") : "signed",
          toAddress: request.to,
          value: request.value,
          data: request.data,
          chainId,
          txHash: shouldBroadcast ? hash : undefined,
          executionBackend: options.expectedBackend,
          executionBackendIdentityDigest: options.expectedBackendIdentityDigest,
          policyResults: options.policyResults ?? [],
          signedAt,
        },
        setWhere: eq(transactions.agentId, request.agentId),
      })
      .returning({ agentId: transactions.agentId });
    if (recordedTransactions.length !== 1) {
      throw new Error("Transaction id already belongs to a different agent");
    }
  }

  /**
   * Create a new agent wallet. Generates BOTH an EVM keypair AND a Solana keypair.
   * The EVM address is stored in `agents.walletAddress` for backwards compatibility.
   * Both addresses are stored in `agent_wallets` and both encrypted keys in
   * `encrypted_chain_keys`. The EVM key is also stored in the legacy
   * `encrypted_keys` table for backwards compatibility.
   *
   * @param chainType - Deprecated; ignored. Both chain families are always generated.
   */
  async createAgent(
    tenantId: string,
    agentId: string,
    name: string,
    platformId?: string,
    _chainType?: "evm" | "solana",
  ): Promise<AgentIdentity> {
    const db = getDb();
    const [existingAgent] = await db
      .select()
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.tenantId, tenantId)));

    if (existingAgent) {
      throw new Error(`Agent ${agentId} already exists for tenant ${tenantId}`);
    }

    // ── Generate EVM keypair ─────────────────────────────────────────────
    const evmPrivateKey = generatePrivateKey();
    const evmAccount = privateKeyToAccount(evmPrivateKey);
    const evmAddress = evmAccount.address;

    // ── Generate Solana keypair ──────────────────────────────────────────
    const solKp = generateSolanaKeypair();
    const solanaAddress = solKp.publicKey;

    // ── Encrypt both keys ────────────────────────────────────────────────
    const evmEncrypted = await this.keyStore.encrypt(evmPrivateKey, {
      tenantId,
      agentId,
      chainFamily: "evm",
      venue: null,
    });
    const solEncrypted = await this.keyStore.encrypt(solKp.secretKey, {
      tenantId,
      agentId,
      chainFamily: "solana",
      venue: null,
    });

    const createdAt = new Date();

    // ── Persist all rows atomically - roll back everything on any failure ─
    await db.transaction(async (tx) => {
      // ── Persist agent row (walletAddress = EVM for backward compat) ────
      await tx.insert(agents).values({
        id: agentId,
        tenantId,
        name,
        walletAddress: evmAddress,
        platformId,
        createdAt,
        updatedAt: createdAt,
      });

      // ── Legacy encrypted_keys table (EVM key only, backward compat) ────
      await tx.insert(encryptedKeys).values({
        agentId,
        ciphertext: evmEncrypted.ciphertext,
        iv: evmEncrypted.iv,
        tag: evmEncrypted.tag,
        salt: evmEncrypted.salt,
      });

      // ── Multi-chain key storage ──────────────────────────────────────
      await tx.insert(encryptedChainKeys).values([
        {
          agentId,
          chainFamily: "evm",
          ciphertext: evmEncrypted.ciphertext,
          iv: evmEncrypted.iv,
          tag: evmEncrypted.tag,
          salt: evmEncrypted.salt,
        },
        {
          agentId,
          chainFamily: "solana",
          ciphertext: solEncrypted.ciphertext,
          iv: solEncrypted.iv,
          tag: solEncrypted.tag,
          salt: solEncrypted.salt,
        },
      ]);

      // ── Multi-chain public address storage ───────────────────────────
      await tx.insert(agentWallets).values([
        {
          agentId,
          chainFamily: "evm",
          address: evmAddress,
          venue: null,
          purpose: null,
          metadata: {},
          createdAt,
        },
        {
          agentId,
          chainFamily: "solana",
          address: solanaAddress,
          venue: null,
          purpose: null,
          metadata: {},
          createdAt,
        },
      ]);
    });

    return {
      id: agentId,
      tenantId,
      name,
      walletAddress: evmAddress,
      walletAddresses: { evm: evmAddress, solana: solanaAddress },
      platformId,
      createdAt,
    };
  }

  /**
   * Create a new agent wallet from a BIP-39 mnemonic.
   *
   * This is intentionally only for NEW agents: assigning a mnemonic to an
   * already-random wallet would create a false recovery guarantee. The caller
   * is responsible for showing the mnemonic exactly once and never persisting it.
   */
  async createAgentFromMnemonic(
    tenantId: string,
    agentId: string,
    name: string,
    mnemonic: string,
    options: {
      platformId?: string;
      passphrase?: string;
      walletType?: string;
      evmIndex?: number;
      solanaAccount?: number;
    } = {},
  ): Promise<AgentIdentity> {
    const db = getDb();
    const [existingAgent] = await db
      .select()
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.tenantId, tenantId)));

    if (existingAgent) {
      throw new Error(`Agent ${agentId} already exists for tenant ${tenantId}`);
    }

    const material = await this.deriveMnemonicWalletMaterial(mnemonic, {
      passphrase: options.passphrase,
      evmIndex: options.evmIndex,
      solanaAccount: options.solanaAccount,
    });

    const evmEncrypted = await this.keyStore.encrypt(material.evmPrivateKey, {
      tenantId,
      agentId,
      chainFamily: "evm",
      venue: null,
    });
    const solEncrypted = await this.keyStore.encrypt(material.solanaSecretHex, {
      tenantId,
      agentId,
      chainFamily: "solana",
      venue: null,
    });
    const createdAt = new Date();

    await db.transaction(async (tx) => {
      await tx.insert(agents).values({
        id: agentId,
        tenantId,
        name,
        walletAddress: material.evmAddress,
        platformId: options.platformId,
        walletType: options.walletType ?? "recoverable",
        createdAt,
        updatedAt: createdAt,
      });

      await tx.insert(encryptedKeys).values({
        agentId,
        ciphertext: evmEncrypted.ciphertext,
        iv: evmEncrypted.iv,
        tag: evmEncrypted.tag,
        salt: evmEncrypted.salt,
      });

      await tx.insert(encryptedChainKeys).values([
        {
          agentId,
          chainFamily: "evm",
          ciphertext: evmEncrypted.ciphertext,
          iv: evmEncrypted.iv,
          tag: evmEncrypted.tag,
          salt: evmEncrypted.salt,
        },
        {
          agentId,
          chainFamily: "solana",
          ciphertext: solEncrypted.ciphertext,
          iv: solEncrypted.iv,
          tag: solEncrypted.tag,
          salt: solEncrypted.salt,
        },
      ]);

      await tx.insert(agentWallets).values([
        {
          agentId,
          chainFamily: "evm",
          address: material.evmAddress,
          venue: null,
          purpose: null,
          metadata: {},
          createdAt,
        },
        {
          agentId,
          chainFamily: "solana",
          address: material.solanaAddress,
          venue: null,
          purpose: null,
          metadata: {},
          createdAt,
        },
      ]);
    });

    return {
      id: agentId,
      tenantId,
      name,
      walletAddress: material.evmAddress,
      walletAddresses: {
        evm: material.evmAddress,
        solana: material.solanaAddress,
      },
      platformId: options.platformId,
      createdAt,
    };
  }

  private async deriveMnemonicWalletMaterial(
    mnemonic: string,
    options: {
      passphrase?: string;
      evmIndex?: number;
      solanaAccount?: number;
    } = {},
  ): Promise<MnemonicWalletMaterial> {
    const evmKey = await deriveEvmKey(mnemonic, {
      index: options.evmIndex,
      passphrase: options.passphrase,
    });
    const evmAddress = privateKeyToAccount(evmKey.privateKey).address;
    const solKey = await deriveSolanaKey(mnemonic, {
      account: options.solanaAccount,
      passphrase: options.passphrase,
    });
    const solanaSecretHex = bytesToHex(solKey.secretKey);
    const solanaAddress =
      restoreSolanaKeypair(solanaSecretHex).publicKey.toBase58();
    return {
      evmPrivateKey: evmKey.privateKey,
      evmAddress,
      solanaSecretHex,
      solanaAddress,
    };
  }

  /**
   * Restore/import a mnemonic-backed agent wallet.
   *
   * Safe cases:
   *   - no agent exists: create the deterministic recoverable wallet;
   *   - a recoverable agent exists and the mnemonic derives the exact stored
   *     EVM/Solana identities: re-encrypt the derived keys for this deployment.
   *
   * Unsafe cases fail closed: an existing random/non-recoverable wallet or a
   * mnemonic whose derived addresses differ from the stored identity is refused.
   */
  async restoreAgentFromMnemonic(
    tenantId: string,
    agentId: string,
    name: string,
    mnemonic: string,
    options: {
      platformId?: string;
      passphrase?: string;
      walletType?: string;
      evmIndex?: number;
      solanaAccount?: number;
    } = {},
  ): Promise<RestoreAgentFromMnemonicResult> {
    const db = getDb();
    const [existingAgent] = await db
      .select()
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.tenantId, tenantId)));

    if (!existingAgent) {
      const created = await this.createAgentFromMnemonic(
        tenantId,
        agentId,
        name,
        mnemonic,
        options,
      );
      return { ...created, restoredExisting: false };
    }

    const walletType = existingAgent.walletType ?? "agent";
    const expectedType = options.walletType ?? "recoverable";
    if (walletType !== expectedType) {
      throw new Error(
        "Existing wallet is not mnemonic-recoverable; refusing unsafe restore",
      );
    }

    const material = await this.deriveMnemonicWalletMaterial(mnemonic, {
      passphrase: options.passphrase,
      evmIndex: options.evmIndex,
      solanaAccount: options.solanaAccount,
    });
    const wallets = await db
      .select()
      .from(agentWallets)
      .where(eq(agentWallets.agentId, agentId));
    const evmWallet = wallets.find(
      (wallet) => wallet.chainFamily === "evm" && wallet.venue === null,
    );
    const solanaWallet = wallets.find(
      (wallet) => wallet.chainFamily === "solana" && wallet.venue === null,
    );

    // A recovery phrase proves the local key identity, but it does not grant
    // permission to silently switch a wallet that is explicitly routed to an
    // external custodian back to server-managed custody.
    if (
      (evmWallet && isExternalKeyWalletMetadata(evmWallet.metadata)) ||
      (solanaWallet && isExternalKeyWalletMetadata(solanaWallet.metadata))
    ) {
      throw new Error(
        "Cannot restore local mnemonic keys over an external-custody wallet",
      );
    }

    if (
      existingAgent.walletAddress.toLowerCase() !==
      material.evmAddress.toLowerCase()
    ) {
      throw new Error("Mnemonic does not match the existing wallet identity");
    }
    if (
      evmWallet &&
      evmWallet.address.toLowerCase() !== material.evmAddress.toLowerCase()
    ) {
      throw new Error("Mnemonic does not match the existing wallet identity");
    }
    if (solanaWallet && solanaWallet.address !== material.solanaAddress) {
      throw new Error("Mnemonic does not match the existing wallet identity");
    }

    const evmEncrypted = await this.keyStore.encrypt(material.evmPrivateKey, {
      tenantId,
      agentId,
      chainFamily: "evm",
      venue: null,
    });
    const solEncrypted = await this.keyStore.encrypt(material.solanaSecretHex, {
      tenantId,
      agentId,
      chainFamily: "solana",
      venue: null,
    });
    const now = new Date();

    await db.transaction(async (tx) => {
      // Restore writes both venue-less key families. Join the same
      // custody-transition fence as importKey/importExternalKeyHandle in a
      // deterministic order, then repeat the guard under the locks so a
      // concurrent handle import cannot commit between the check and writes.
      if (usesCustodyAdvisoryLock()) {
        for (const family of ["evm", "solana"] as const) {
          await tx.execute(
            sql`select pg_advisory_xact_lock(hashtextextended(${custodyTransitionLockKey(tenantId, agentId, family, null)}, 0))`,
          );
        }
      }
      const lockedWallets = await tx
        .select({ metadata: agentWallets.metadata })
        .from(agentWallets)
        .where(
          and(
            eq(agentWallets.agentId, agentId),
            inArray(agentWallets.chainFamily, ["evm", "solana"]),
            isNull(agentWallets.venue),
          ),
        );
      if (
        lockedWallets.some((wallet) =>
          isExternalKeyWalletMetadata(wallet.metadata),
        )
      ) {
        throw new Error(
          "Cannot restore local mnemonic keys over an external-custody wallet",
        );
      }

      await tx
        .update(agents)
        .set({
          walletAddress: material.evmAddress,
          platformId: options.platformId ?? existingAgent.platformId,
          updatedAt: now,
        })
        .where(and(eq(agents.id, agentId), eq(agents.tenantId, tenantId)));

      await tx
        .insert(encryptedKeys)
        .values({
          agentId,
          ciphertext: evmEncrypted.ciphertext,
          iv: evmEncrypted.iv,
          tag: evmEncrypted.tag,
          salt: evmEncrypted.salt,
        })
        .onConflictDoUpdate({
          target: encryptedKeys.agentId,
          set: {
            ciphertext: evmEncrypted.ciphertext,
            iv: evmEncrypted.iv,
            tag: evmEncrypted.tag,
            salt: evmEncrypted.salt,
          },
        });

      await tx
        .delete(encryptedChainKeys)
        .where(
          and(
            eq(encryptedChainKeys.agentId, agentId),
            inArray(encryptedChainKeys.chainFamily, ["evm", "solana"]),
            isNull(encryptedChainKeys.venue),
          ),
        );
      await tx.insert(encryptedChainKeys).values([
        {
          agentId,
          chainFamily: "evm",
          venue: null,
          ciphertext: evmEncrypted.ciphertext,
          iv: evmEncrypted.iv,
          tag: evmEncrypted.tag,
          salt: evmEncrypted.salt,
        },
        {
          agentId,
          chainFamily: "solana",
          venue: null,
          ciphertext: solEncrypted.ciphertext,
          iv: solEncrypted.iv,
          tag: solEncrypted.tag,
          salt: solEncrypted.salt,
        },
      ]);

      await tx
        .insert(agentWallets)
        .values([
          {
            agentId,
            chainFamily: "evm",
            venue: null,
            purpose: null,
            metadata: {},
            address: material.evmAddress,
            createdAt: now,
          },
          {
            agentId,
            chainFamily: "solana",
            venue: null,
            purpose: null,
            metadata: {},
            address: material.solanaAddress,
            createdAt: now,
          },
        ])
        .onConflictDoNothing();
    });

    const restored = await this.getAgent(tenantId, agentId);
    if (!restored) {
      throw new Error(`Restored wallet ${agentId} could not be fetched`);
    }
    return { ...restored, restoredExisting: true };
  }

  /**
   * Get an agent's public identity, including `walletAddresses` for agents
   * created with multi-wallet support.
   */
  async getAgent(
    tenantId: string,
    agentId: string,
  ): Promise<AgentIdentity | undefined> {
    const db = getDb();
    const [agent] = await db
      .select()
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.tenantId, tenantId)));

    if (!agent) return undefined;

    const identity = toAgentIdentity(agent) as AgentIdentity;
    const wallets = await db
      .select()
      .from(agentWallets)
      .where(eq(agentWallets.agentId, agentId));

    if (wallets.length > 0) {
      const addresses: Partial<Record<WalletChainFamily, string>> = {};
      for (const w of wallets) {
        if (w.chainFamily === "evm") addresses.evm = w.address;
        if (w.chainFamily === "solana") addresses.solana = w.address;
        if (w.chainFamily === "bitcoin") addresses.bitcoin = w.address;
        if (w.chainFamily === "monero") addresses.monero = w.address;
      }
      identity.walletAddresses = addresses;
    }

    return identity;
  }

  /**
   * List all agent identities for a tenant, including `walletAddresses`
   * for agents created with multi-wallet support.
   */
  async listAgents(
    tenantId: string,
    options: { limit?: number; offset?: number } = {},
  ): Promise<AgentIdentity[]> {
    const db = getDb();
    const limit = Math.min(Math.max(Math.floor(options.limit ?? 100), 1), 200);
    const offset = Math.min(
      Math.max(Math.floor(options.offset ?? 0), 0),
      100_000,
    );
    const rows = await db
      .select()
      .from(agents)
      .where(eq(agents.tenantId, tenantId))
      .limit(limit)
      .offset(offset);
    if (rows.length === 0) return [];

    const agentIds = rows.map((r) => r.id);
    const walletRows = await db
      .select()
      .from(agentWallets)
      .where(inArray(agentWallets.agentId, agentIds));

    // Build a map: agentId -> { evm?, solana?, bitcoin? }
    const walletMap = new Map<
      string,
      Partial<Record<WalletChainFamily, string>>
    >();
    for (const w of walletRows) {
      if (!walletMap.has(w.agentId)) walletMap.set(w.agentId, {});
      const entry = requireLoginValue(
        walletMap.get(w.agentId),
        "walletMap.get(w.agentId)",
      );
      if (w.chainFamily === "evm") entry.evm = w.address;
      if (w.chainFamily === "solana") entry.solana = w.address;
      if (w.chainFamily === "bitcoin") entry.bitcoin = w.address;
      if (w.chainFamily === "monero") entry.monero = w.address;
    }

    return rows.map((agent) => {
      const identity = toAgentIdentity(agent) as AgentIdentity;
      const addresses = walletMap.get(agent.id);
      if (addresses && Object.keys(addresses).length > 0) {
        identity.walletAddresses = addresses;
      }
      return identity;
    });
  }

  /**
   * List all agent identities for a tenant (alias for listAgents).
   */
  async listAgentsByTenant(
    tenantId: string,
    options: { limit?: number; offset?: number } = {},
  ): Promise<AgentIdentity[]> {
    return this.listAgents(tenantId, options);
  }

  /**
   * Get all wallet addresses for an agent across all chain families.
   * Returns a map of chainFamily → address.
   */
  async getAddresses(
    tenantId: string,
    agentId: string,
  ): Promise<Array<{ chainFamily: WalletChainFamily; address: string }>> {
    const db = getDb();
    // Verify agent belongs to this tenant
    const [agent] = await db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.tenantId, tenantId)));
    if (!agent) {
      throw new Error(`Agent ${agentId} not found for tenant ${tenantId}`);
    }

    const wallets = await db
      .select()
      .from(agentWallets)
      .where(eq(agentWallets.agentId, agentId));

    // For legacy agents with no rows in agent_wallets, fall back to agents.walletAddress
    if (wallets.length === 0) {
      const [agentRow] = await db
        .select({ walletAddress: agents.walletAddress })
        .from(agents)
        .where(eq(agents.id, agentId));
      if (agentRow) {
        const chainFamily = detectChainType(agentRow.walletAddress);
        return [{ chainFamily, address: agentRow.walletAddress }];
      }
      return [];
    }

    return wallets.map((w) => ({
      chainFamily: w.chainFamily as WalletChainFamily,
      address: w.address,
    }));
  }

  /**
   * Sign a transaction. Decrypts the key, signs, then discards the key.
   * Routes to Solana or EVM based on chainId (101/102 = Solana, otherwise EVM).
   *
   * When `broadcast` is false (or request.broadcast is false), returns the
   * serialized signed transaction instead of broadcasting it.
   * Returns the transaction hash (when broadcast) or signed serialized tx (when not).
   */
  async signTransaction(
    request: SignRequest,
    options: SignTransactionOptions = {},
  ): Promise<string> {
    const db = getDb();

    // Verify agent exists for this tenant
    const [agentRow] = await db
      .select({ id: agents.id, walletAddress: agents.walletAddress })
      .from(agents)
      .where(
        and(
          eq(agents.id, request.agentId),
          eq(agents.tenantId, request.tenantId),
        ),
      );

    if (!agentRow) {
      throw new Error(
        `Agent ${request.agentId} not found for tenant ${request.tenantId}`,
      );
    }

    const chainId = request.chainId || this.config.chainId || 8453;
    // Determine chain family from chainId (101/102 = Solana)
    const isSolana = chainId === 101 || chainId === 102;
    const chainFamilyToUse = isSolana ? "solana" : "evm";
    const shouldBroadcast = request.broadcast !== false;
    const venue = resolveSignVenueSelector(request);
    await assertVaultSigningActive({
      tenantId: request.tenantId,
      agentId: request.agentId,
      chainFamily: chainFamilyToUse,
      venue,
      walletAddress: request.walletAddress,
    });

    // ── Resolve the correct signing key ─────────────────────────────────
    // 1. Try the multi-chain key table (new agents)
    // 2. Fall back to legacy single-key table (old EVM-only agents)
    let secretKey: string;
    const [chainKey] = await db
      .select()
      .from(encryptedChainKeys)
      .where(
        and(
          eq(encryptedChainKeys.agentId, request.agentId),
          eq(encryptedChainKeys.chainFamily, chainFamilyToUse),
          venue
            ? eq(encryptedChainKeys.venue, venue)
            : isNull(encryptedChainKeys.venue),
        ),
      );

    if (chainKey) {
      if (options.expectedBackend === "external-custody") {
        throw new BackendBindingMismatchError(
          "external-custody",
          "local-vault",
        );
      }
      secretKey = await this.keyStore.decrypt(
        {
          ciphertext: chainKey.ciphertext,
          iv: chainKey.iv,
          tag: chainKey.tag,
          salt: chainKey.salt,
        },
        {
          tenantId: request.tenantId,
          agentId: request.agentId,
          chainFamily: chainFamilyToUse,
          // Bind to the resolved venue selector so venue-scoped keys (provisioned
          // with the venue in their AAD context) decrypt correctly; null for the
          // default unscoped key.
          venue: chainKey.venue ?? venue,
        },
      );
    } else {
      const externalWallet = await this.getExternalKeyWallet({
        agentId: request.agentId,
        chainFamily: chainFamilyToUse,
        venue,
      });
      if (externalWallet) {
        if (options.expectedBackend !== "external-custody") {
          throw new BackendBindingMismatchError(
            options.expectedBackend ?? "local-vault",
            "external-custody",
          );
        }
        // Backend-binding re-resolution (TOCTOU close).
        // This branch uses the SAME fresh wallet lookup that will actually sign
        // (no second racy read). External custody is reachable only through an
        // exact backend + identity binding; legacy raw callers fail closed
        // before any provider routing.
        const resolvedIdentityDigest = externalCustodyIdentityDigest({
          providerId: externalWallet.metadata.externalKey.providerId,
          keyId: externalWallet.metadata.externalKey.keyId,
          version: externalWallet.metadata.externalKey.version,
          region: externalWallet.metadata.externalKey.region,
          address: externalWallet.address,
        });
        if (
          options.expectedBackend === "external-custody" &&
          options.expectedBackendIdentityDigest !== resolvedIdentityDigest
        ) {
          throw new BackendBindingMismatchError(
            "external-custody",
            "external-custody",
            true,
          );
        }
        if (request.walletAddress && externalWallet.address) {
          if (
            externalWallet.address.toLowerCase() !==
            request.walletAddress.toLowerCase()
          ) {
            throw new Error(
              `Wallet address mismatch: resolved ${externalWallet.address} but request specified ${request.walletAddress}`,
            );
          }
        }
        if (
          externalWallet.metadata.externalKey.signingAvailability !==
            "provider-signing" ||
          !this.externalKeyCustodyProvider?.signTransaction
        ) {
          throw externalKeySigningUnavailableError();
        }
        const rpcUrl = isSolana
          ? (this.config.rpcUrl ?? resolveSolanaRpc(chainId))
          : (CHAIN_RPCS[chainId] ?? this.config.rpcUrl);
        let signed;
        let preparedBroadcastHash: string | undefined;
        try {
          signed = await this.externalKeyCustodyProvider.signTransaction({
            tenantId: request.tenantId,
            agentId: request.agentId,
            chainFamily: chainFamilyToUse,
            address: externalWallet.address,
            handle: {
              providerId: externalWallet.metadata.externalKey.providerId,
              keyId: externalWallet.metadata.externalKey.keyId,
              version: externalWallet.metadata.externalKey.version,
              region: externalWallet.metadata.externalKey.region,
            },
            venue,
            chainId,
            to: request.to,
            value: request.value,
            data: request.data,
            gasLimit: request.gasLimit,
            nonce: request.nonce,
            broadcast: shouldBroadcast,
            rpcUrl,
            ...(shouldBroadcast
              ? {
                  onPreparedBroadcast: async (transactionHash: string) => {
                    if (
                      preparedBroadcastHash &&
                      preparedBroadcastHash.toLowerCase() !==
                        transactionHash.toLowerCase()
                    ) {
                      throw new Error(
                        "External custody signer changed the prepared transaction hash",
                      );
                    }
                    await this.recordSignedTransaction(
                      request,
                      chainId,
                      true,
                      transactionHash,
                      {
                        ...options,
                        status: "outcome_unknown",
                      },
                    );
                    preparedBroadcastHash = transactionHash;
                  },
                }
              : {}),
          });
        } catch (error) {
          const outcomeError =
            error instanceof ExternalBroadcastOutcomeUnknownError
              ? preparedBroadcastHash &&
                preparedBroadcastHash.toLowerCase() !==
                  error.transactionHash.toLowerCase()
                ? new ExternalBroadcastOutcomeUnknownError(
                    preparedBroadcastHash,
                    { cause: error },
                  )
                : error
              : shouldBroadcast && preparedBroadcastHash
                ? new ExternalBroadcastOutcomeUnknownError(
                    preparedBroadcastHash,
                    { cause: error },
                  )
                : null;
          if (outcomeError) {
            // The provider has already produced a deterministic local hash and
            // may have handed the signed bytes to the RPC.  A database failure
            // must never replace this irreversible outcome with a generic
            // error: approval callers would otherwise reopen the queue and a
            // retry could broadcast the same intent again.  The gateway
            // pre-stages direct executions (and approval executions already
            // have a transaction row), so it can durably recover the exact
            // hash even when this first write fails.
            try {
              await this.recordSignedTransaction(
                request,
                chainId,
                true,
                outcomeError.transactionHash,
                {
                  ...options,
                  status: "outcome_unknown",
                },
              );
            } catch {
              // Deliberately preserve the typed error and its hash. Do not log
              // the persistence exception: provider/RPC errors may contain
              // credential-bearing URLs, and the gateway owns the bounded
              // fallback persistence/audit path.
            }
            throw outcomeError;
          }
          throw error;
        }
        try {
          assertNoExternalPrivateKeyMaterial(
            signed,
            "externalSignTransactionResult",
          );
          if (signed.broadcast !== shouldBroadcast) {
            throw new Error(
              "External key custody signer returned an unexpected broadcast mode",
            );
          }
          if (
            shouldBroadcast &&
            preparedBroadcastHash &&
            signed.result.toLowerCase() !== preparedBroadcastHash.toLowerCase()
          ) {
            throw new ExternalBroadcastOutcomeUnknownError(
              preparedBroadcastHash,
              {
                cause: new Error(
                  "External custody signer returned a mismatched transaction hash",
                ),
              },
            );
          }
          await this.recordSignedTransaction(
            request,
            chainId,
            shouldBroadcast,
            signed.result,
            options,
          );
        } catch (error) {
          // Once the durable checkpoint has completed, every later failure is
          // post-irreversibility: the provider may already have submitted the
          // signed bytes. Preserve the exact prepared hash and never let the
          // approval gateway classify this as retryable.
          if (
            shouldBroadcast &&
            preparedBroadcastHash &&
            !(error instanceof ExternalBroadcastOutcomeUnknownError)
          ) {
            throw new ExternalBroadcastOutcomeUnknownError(
              preparedBroadcastHash,
              { cause: error },
            );
          }
          throw error;
        }
        return signed.result;
      }
      if (venue) {
        throw missingSigningKeyError(request.agentId, chainFamilyToUse, venue);
      }
      // Fallback: legacy encrypted_keys table (EVM only).
      // Same backend-binding guard as the encryptedChainKeys branch above:
      // an external-custody-bound authorization must never fall through to
      // local key material — if the wallet flipped custody after the gateway
      // precheck, signing with a stale legacy key would bypass the bound
      // provider. Fail closed before reading any key material.
      if (options.expectedBackend === "external-custody") {
        throw new BackendBindingMismatchError(
          "external-custody",
          "local-vault",
        );
      }
      const [legacyKey] = await db
        .select()
        .from(encryptedKeys)
        .where(eq(encryptedKeys.agentId, request.agentId));
      if (!legacyKey) {
        throw missingSigningKeyError(request.agentId, chainFamilyToUse);
      }
      secretKey = await this.keyStore.decrypt(legacyKey as EncryptedKey, {
        tenantId: request.tenantId,
        agentId: request.agentId,
        chainFamily: chainFamilyToUse,
        venue: null,
      });
    }

    // Also resolve the wallet address for this chain (for Solana tx signing)
    let _walletAddress: string = agentRow.walletAddress; // default EVM
    if (isSolana) {
      const [solWallet] = await db
        .select({ address: agentWallets.address })
        .from(agentWallets)
        .where(
          and(
            eq(agentWallets.agentId, request.agentId),
            eq(agentWallets.chainFamily, "solana"),
            venue ? eq(agentWallets.venue, venue) : isNull(agentWallets.venue),
          ),
        );
      if (solWallet) _walletAddress = solWallet.address;
      else
        _walletAddress =
          detectChainType(agentRow.walletAddress) === "solana"
            ? agentRow.walletAddress
            : ""; // no solana wallet
    }

    let hash: string;

    if (isSolana) {
      if (request.walletAddress && _walletAddress) {
        if (
          _walletAddress.toLowerCase() !== request.walletAddress.toLowerCase()
        ) {
          throw new Error(
            `Wallet address mismatch: resolved ${_walletAddress} but request specified ${request.walletAddress}`,
          );
        }
      }
      const rpcUrl = this.config.rpcUrl ?? resolveSolanaRpc(chainId);
      hash = await signSolanaTransaction(
        secretKey,
        request.to,
        BigInt(request.value),
        rpcUrl,
        {
          broadcast: shouldBroadcast,
          // Attach adaptive priority fees (simulated CU limit + recent-fee-derived
          // price, bounded by COMPUTE_BUDGET_BOUNDS). Estimation never throws and
          // falls back to safe defaults on RPC error. Set STEWARD_SOLANA_PRIORITY_FEES=0
          // to revert to the legacy no-compute-budget transfer.
          computeBudget:
            process.env.STEWARD_SOLANA_PRIORITY_FEES === "0" ? false : {},
        },
      );
    } else {
      assertEvmWalletAddressMatches(secretKey, request.walletAddress);
      const account = privateKeyToAccount(secretKey as `0x${string}`);
      const chain = CHAINS[chainId];
      if (!chain) {
        throw new Error(`Unsupported EVM chain: ${chainId}`);
      }

      if (shouldBroadcast) {
        // Use chain-specific RPC. Prior versions fell back to
        // `this.config.rpcUrl` which is tenant-wide and may not match
        // the target chain (e.g. Steward config pointed at Base but
        // the tx is for BSC), causing RPC-side balance checks to fail
        // with 'total cost exceeds balance' (wrong chain's balance).
        const rpcUrl = CHAIN_RPCS[chainId] ?? this.config.rpcUrl;
        const client = createWalletClient({
          account,
          chain,
          transport: http(rpcUrl),
        });
        const publicClient = createPublicClient({
          chain,
          // The signed bytes are submitted exactly once at the application and
          // transport layers. A lost response is reconciled by hash, never by
          // replaying eth_sendRawTransaction.
          transport: http(rpcUrl, { retryCount: 0 }),
        });
        // Track only allocator-issued nonces for in-flight reclaim; a
        // caller-supplied `request.nonce` is the caller's responsibility.
        const allocatedNonce =
          request.nonce === undefined
            ? await allocateEvmNonce({
                tenantId: request.tenantId,
                walletAddress: account.address,
                chainId,
                getPendingNonce: (address) =>
                  publicClient.getTransactionCount({
                    address,
                    blockTag: "pending",
                  }),
              })
            : undefined;
        const nonce = request.nonce ?? (allocatedNonce as number);

        // Keep the pre-broadcast checkpoint and accepted update on one durable
        // transaction id even for legacy callers that did not supply one.
        const localRecordOptions: SignTransactionOptions = {
          ...options,
          txId: options.txId ?? randomUUID(),
        };

        return executeLocalEvmBroadcast({
          prepare: async () => {
            const prepared = await client.prepareTransactionRequest({
              to: request.to as `0x${string}`,
              value: BigInt(request.value),
              data: request.data as `0x${string}` | undefined,
              gas: request.gasLimit ? BigInt(request.gasLimit) : undefined,
              nonce,
            });
            return client.signTransaction(prepared);
          },
          checkpoint: (transactionHash) =>
            this.recordSignedTransaction(
              request,
              chainId,
              true,
              transactionHash,
              {
                ...localRecordOptions,
                status: "outcome_unknown",
              },
            ),
          broadcast: (serializedTransaction) =>
            publicClient.sendRawTransaction({ serializedTransaction }),
          reconcile: async (transactionHash) => {
            try {
              const transaction = await publicClient.getTransaction({
                hash: transactionHash,
              });
              return (
                transaction.hash.toLowerCase() === transactionHash.toLowerCase()
              );
            } catch {
              return false;
            }
          },
          releaseBeforeBroadcast: async () => {
            if (allocatedNonce === undefined) return;
            await markEvmNonceDropped({
              tenantId: request.tenantId,
              walletAddress: account.address,
              chainId,
              nonce: allocatedNonce,
            });
          },
          finalizeAccepted: async (transactionHash) => {
            if (allocatedNonce !== undefined) {
              // Best-effort: allocator bookkeeping cannot invalidate an
              // accepted, deterministically identified transaction.
              await confirmEvmNonce({
                tenantId: request.tenantId,
                walletAddress: account.address,
                chainId,
                nonce: allocatedNonce,
              }).catch(() => {});
            }
            await this.recordSignedTransaction(
              request,
              chainId,
              true,
              transactionHash,
              {
                ...localRecordOptions,
                status: localRecordOptions.status ?? "broadcast",
              },
            );
          },
        });
      } else {
        // Sign without broadcasting - return the serialized signed transaction
        const rpcUrl = CHAIN_RPCS[chainId] ?? this.config.rpcUrl;
        const publicClient = createPublicClient({
          chain,
          transport: http(rpcUrl),
        });
        const nonce =
          request.nonce ??
          (await allocateEvmNonce({
            tenantId: request.tenantId,
            walletAddress: account.address,
            chainId,
            getPendingNonce: (address) =>
              publicClient.getTransactionCount({
                address,
                blockTag: "pending",
              }),
          }));
        const gasPrice = await publicClient.getGasPrice();

        const txRequest: TransactionSerializable = {
          to: request.to as `0x${string}`,
          value: BigInt(request.value),
          data: request.data as `0x${string}` | undefined,
          gas: request.gasLimit ? BigInt(request.gasLimit) : 21000n,
          nonce,
          gasPrice,
          chainId,
        };

        hash = await account.signTransaction(txRequest);
      }
    }

    await this.recordSignedTransaction(
      request,
      chainId,
      shouldBroadcast,
      hash,
      options,
    );

    return hash;
  }

  /**
   * Get the on-chain native balance for an agent's wallet.
   * Auto-detects EVM vs Solana from the wallet address format.
   * For Solana, pass chainId 101 (mainnet-beta) or 102 (devnet).
   */
  async getBalance(
    tenantId: string,
    agentId: string,
    chainId?: number,
  ): Promise<{
    native: bigint;
    nativeFormatted: string;
    chainId: number;
    symbol: string;
    walletAddress: string;
  }> {
    const agent = await this.getAgent(tenantId, agentId);
    if (!agent) {
      throw new Error(`Agent ${agentId} not found for tenant ${tenantId}`);
    }

    // For multi-wallet agents, chainId 101/102 requests Solana balance
    // For legacy agents, fall back to detecting from walletAddress format
    const requestedSolana = chainId === 101 || chainId === 102;
    const solanaAddress =
      agent.walletAddresses?.solana ??
      (detectChainType(agent.walletAddress) === "solana"
        ? agent.walletAddress
        : undefined);
    const isSolana =
      requestedSolana ||
      (!chainId &&
        Boolean(solanaAddress) &&
        detectChainType(agent.walletAddress) === "solana");

    if (isSolana && solanaAddress) {
      const resolvedChainId = chainId ?? 101;
      const rpcUrl = this.config.rpcUrl ?? resolveSolanaRpc(resolvedChainId);
      const { lamports, formatted } = await getSolanaBalance(
        solanaAddress,
        rpcUrl,
      );
      return {
        native: lamports,
        nativeFormatted: formatted,
        chainId: resolvedChainId,
        symbol: "SOL",
        walletAddress: solanaAddress,
      };
    }

    const resolvedChainId =
      chainId && !requestedSolana ? chainId : (this.config.chainId ?? 8453);
    const chain = CHAINS[resolvedChainId];
    if (!chain) {
      throw new Error(`Unsupported EVM chain: ${resolvedChainId}`);
    }

    const evmAddress = agent.walletAddresses?.evm ?? agent.walletAddress;
    const rpcUrl = CHAIN_RPCS[resolvedChainId] ?? this.config.rpcUrl;
    const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
    const native = await publicClient.getBalance({
      address: evmAddress as `0x${string}`,
    });

    return {
      native,
      nativeFormatted: formatEther(native),
      chainId: resolvedChainId,
      symbol: chain.nativeCurrency.symbol,
      walletAddress: evmAddress,
    };
  }

  /**
   * Get ERC-20 token balances for an agent's EVM wallet on a given chain.
   *
   * @param tenantId - The tenant that owns the agent
   * @param agentId  - The agent whose wallet to query
   * @param chainId  - EVM chain ID (defaults to config chainId or 8453)
   * @param tokens   - Optional custom token contract addresses. If omitted, uses common tokens.
   * @returns Array of token balances including symbol, decimals, and formatted amounts.
   */
  async getTokenBalances(
    tenantId: string,
    agentId: string,
    chainId?: number,
    tokens?: string[],
  ): Promise<TokenBalance[]> {
    const agent = await this.getAgent(tenantId, agentId);
    if (!agent) {
      throw new Error(`Agent ${agentId} not found for tenant ${tenantId}`);
    }

    const resolvedChainId = chainId ?? this.config.chainId ?? 8453;
    const evmAddress = agent.walletAddresses?.evm ?? agent.walletAddress;
    const rpcUrl = CHAIN_RPCS[resolvedChainId] ?? this.config.rpcUrl;

    return fetchTokenBalances(evmAddress, resolvedChainId, tokens, rpcUrl);
  }

  /**
   * Get SPL token balances for an agent's Solana wallet.
   *
   * This uses parsed Solana RPC token-account reads. It does not require or
   * imply a production portfolio indexer; only mints in Steward's audited local
   * token registry receive a ticker label.
   */
  async getSplTokenBalances(
    tenantId: string,
    agentId: string,
    chainId?: number,
  ): Promise<SplTokenBalance[]> {
    const agent = await this.getAgent(tenantId, agentId);
    if (!agent) {
      throw new Error(`Agent ${agentId} not found for tenant ${tenantId}`);
    }

    const resolvedChainId =
      chainId && (chainId === 101 || chainId === 102) ? chainId : 101;
    const solanaAddress =
      agent.walletAddresses?.solana ??
      (detectChainType(agent.walletAddress) === "solana"
        ? agent.walletAddress
        : undefined);
    if (!solanaAddress) {
      throw new Error(`Agent ${agentId} does not have a Solana wallet`);
    }
    const rpcUrl = this.config.rpcUrl ?? resolveSolanaRpc(resolvedChainId);

    return fetchSplTokenBalances(solanaAddress, rpcUrl, resolvedChainId);
  }

  async buildSolanaSplTransferTransaction(request: {
    agentId: string;
    tenantId: string;
    to: string;
    token: string;
    value: string;
    chainId: number;
  }): Promise<SolanaSplTransferTransaction> {
    const db = getDb();
    const [agentRow] = await db
      .select({ walletAddress: agents.walletAddress })
      .from(agents)
      .where(
        and(
          eq(agents.id, request.agentId),
          eq(agents.tenantId, request.tenantId),
        ),
      );
    if (!agentRow) {
      throw new Error(
        `Agent ${request.agentId} not found for tenant ${request.tenantId}`,
      );
    }
    const [solWallet] = await db
      .select({ address: agentWallets.address })
      .from(agentWallets)
      .where(
        and(
          eq(agentWallets.agentId, request.agentId),
          eq(agentWallets.chainFamily, "solana"),
          isNull(agentWallets.venue),
        ),
      );
    const from =
      solWallet?.address ??
      (detectChainType(agentRow.walletAddress) === "solana"
        ? agentRow.walletAddress
        : null);
    if (!from) {
      throw new Error(`Agent ${request.agentId} does not have a Solana wallet`);
    }
    const rpcUrl = this.config.rpcUrl ?? resolveSolanaRpc(request.chainId);
    return buildSolanaSplTransferTx({
      from,
      to: request.to,
      mint: request.token,
      amount: BigInt(request.value),
      rpcUrl,
    });
  }

  /**
   * Import an existing private key into the vault for an agent.
   * Creates the agent record if it doesn't exist, or updates the key if it does.
   * Returns the derived public address.
   *
   * @param chainType - "evm" or "solana"
   */
  async importKey(
    tenantId: string,
    agentId: string,
    privateKey: string,
    chainType: "evm" | "solana",
  ): Promise<{ walletAddress: string }> {
    const db = getDb();

    let walletAddress: string;

    let keyToStore = privateKey;

    if (chainType === "solana") {
      // For Solana, the private key should be a 64-byte hex string (seed + pubkey)
      // or a 32-byte hex seed - we'll handle both
      const kp = restoreSolanaKeypair(privateKey);
      walletAddress = kp.publicKey.toBase58();
    } else {
      // EVM - expect 0x-prefixed hex private key
      const normalizedKey = privateKey.startsWith("0x")
        ? privateKey
        : `0x${privateKey}`;
      const account = privateKeyToAccount(normalizedKey as `0x${string}`);
      walletAddress = account.address;
      keyToStore = normalizedKey;
    }

    const encryptedKey = await this.keyStore.encrypt(keyToStore, {
      tenantId,
      agentId,
      chainFamily: chainType,
      venue: null,
    });
    const now = new Date();

    // Check if agent already exists
    const [existingAgent] = await db
      .select()
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.tenantId, tenantId)));

    // Wrap all writes atomically - roll back on any failure
    await db.transaction(async (tx) => {
      // The SEC-024 custody guard below runs inside this transaction after the
      // per-scope advisory lock. A concurrent
      // importExternalKeyHandle for the same (agent, chain family) could
      // interleave between the check and these writes, leaving both a
      // server-managed key and an external-custody wallet row. Serialize
      // custody transitions per scope and run the guard INSIDE the lock so
      // the interleave fails closed. Skipped on single-connection PGlite,
      // where transactions already serialize.
      if (usesCustodyAdvisoryLock()) {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${custodyTransitionLockKey(tenantId, agentId, chainType, null)}, 0))`,
        );
      }

      // SEC-024: refuse to silently convert an external-custody wallet back to
      // server custody — the reverse guard of importExternalKeyHandle. A local
      // chain key here would shadow the HSM on every future sign while the DB
      // still claims external custody.
      const [externalWallet] = await tx
        .select({ metadata: agentWallets.metadata })
        .from(agentWallets)
        .where(
          and(
            eq(agentWallets.agentId, agentId),
            eq(agentWallets.chainFamily, chainType),
            isNull(agentWallets.venue),
          ),
        );
      if (
        externalWallet &&
        isExternalKeyWalletMetadata(externalWallet.metadata)
      ) {
        throw new Error(
          `Cannot import a server-managed key over the external-custody ${chainType} wallet of agent ${agentId}`,
        );
      }

      if (existingAgent) {
        // Update wallet address and replace encrypted key
        await tx
          .update(agents)
          .set({ walletAddress, updatedAt: now })
          .where(and(eq(agents.id, agentId), eq(agents.tenantId, tenantId)));

        // SEC-023: the legacy encrypted_keys table holds the EVM key only.
        // Only replace the legacy row for EVM imports — deleting it for a
        // Solana import would brick a legacy agent's existing EVM key.
        if (chainType === "evm") {
          await tx
            .delete(encryptedKeys)
            .where(eq(encryptedKeys.agentId, agentId));

          await tx.insert(encryptedKeys).values({
            agentId,
            ciphertext: encryptedKey.ciphertext,
            iv: encryptedKey.iv,
            tag: encryptedKey.tag,
            salt: encryptedKey.salt,
          });
        }
      } else {
        // Create new agent record
        await tx.insert(agents).values({
          id: agentId,
          tenantId,
          name: agentId,
          walletAddress,
          createdAt: now,
          updatedAt: now,
        });

        if (chainType === "evm") {
          await tx.insert(encryptedKeys).values({
            agentId,
            ciphertext: encryptedKey.ciphertext,
            iv: encryptedKey.iv,
            tag: encryptedKey.tag,
            salt: encryptedKey.salt,
          });
        }
      }

      // ── Also write to multi-wallet tables so new signing paths find the key ─
      // Upsert into encrypted_chain_keys (replace if key already imported).
      // Target the partial unique index on (agent_id, chain_family)
      // WHERE venue IS NULL so this only conflicts with the legacy row, not
      // with venue-scoped wallets that share the same chain family.
      await tx
        .insert(encryptedChainKeys)
        .values({
          agentId,
          chainFamily: chainType,
          venue: null,
          ciphertext: encryptedKey.ciphertext,
          iv: encryptedKey.iv,
          tag: encryptedKey.tag,
          salt: encryptedKey.salt,
        })
        .onConflictDoUpdate({
          target: [encryptedChainKeys.agentId, encryptedChainKeys.chainFamily],
          targetWhere: sql`${encryptedChainKeys.venue} IS NULL`,
          set: {
            ciphertext: encryptedKey.ciphertext,
            iv: encryptedKey.iv,
            tag: encryptedKey.tag,
            salt: encryptedKey.salt,
          },
        });

      // Upsert into agent_wallets, same partial-index target.
      await tx
        .insert(agentWallets)
        .values({
          agentId,
          chainFamily: chainType,
          venue: null,
          address: walletAddress,
          createdAt: now,
        })
        .onConflictDoUpdate({
          target: [agentWallets.agentId, agentWallets.chainFamily],
          targetWhere: sql`${agentWallets.venue} IS NULL`,
          set: { address: walletAddress },
        });
    });

    return { walletAddress };
  }

  /**
   * Register an external hardware/HSM key handle for an agent.
   *
   * It accepts provider-neutral handle metadata and returns the registered
   * public identity. A v1 provider may also opt into transaction signing, but
   * plaintext private key export is never available for external custody.
   */
  async importExternalKeyHandle(
    request: ExternalKeyHandleImportRequest,
  ): Promise<ExternalKeyHandleRegistration> {
    assertNoExternalPrivateKeyMaterial(request);
    if (!this.externalKeyCustodyProvider) {
      throw externalKeyCustodyUnavailableError();
    }
    if (
      request.chainFamily !== "evm" &&
      request.chainFamily !== "solana" &&
      request.chainFamily !== "bitcoin"
    ) {
      throw new Error(
        `Unsupported external key chain family: ${request.chainFamily}`,
      );
    }
    if (!request.address.trim()) {
      throw new Error(
        "External key handle import requires a public wallet address",
      );
    }
    if (!request.handle.providerId.trim() || !request.handle.keyId.trim()) {
      throw new Error(
        "External key handle import requires providerId and keyId",
      );
    }

    const db = getDb();
    const [agentRow] = await db
      .select({ id: agents.id, walletAddress: agents.walletAddress })
      .from(agents)
      .where(
        and(
          eq(agents.id, request.agentId),
          eq(agents.tenantId, request.tenantId),
        ),
      );
    if (!agentRow) {
      throw new Error(
        `Agent ${request.agentId} not found for tenant ${request.tenantId}`,
      );
    }

    // Fast-fail before the provider round-trip on the common rejection; the
    // authoritative re-check happens inside the locked transaction below.
    // `encrypted_keys` is always the legacy EVM store. Do not infer its
    // relevance from agents.walletAddress: importing a Solana key updates that
    // primary address while deliberately preserving the legacy EVM row.
    if (!request.venue && request.chainFamily === "evm") {
      const [legacyKey] = await db
        .select({ agentId: encryptedKeys.agentId })
        .from(encryptedKeys)
        .where(eq(encryptedKeys.agentId, request.agentId));
      if (legacyKey) {
        throw new Error(
          "Cannot register external key handle over a legacy server-managed key",
        );
      }
    }

    // Non-authoritative fast-fail checks keep a request that is already known
    // to conflict with local custody from reaching the external provider. All
    // checks are repeated under the transaction-scoped lock below because a
    // concurrent writer can change them after this read.
    const venue = request.venue ?? null;
    const scope = and(
      eq(encryptedChainKeys.agentId, request.agentId),
      eq(encryptedChainKeys.chainFamily, request.chainFamily),
      venue
        ? eq(encryptedChainKeys.venue, venue)
        : isNull(encryptedChainKeys.venue),
    );
    const [preexistingEncryptedKey] = await db
      .select({ id: encryptedChainKeys.id })
      .from(encryptedChainKeys)
      .where(scope);
    if (preexistingEncryptedKey) {
      throw new Error(
        "Cannot register external key handle over a server-managed signing key",
      );
    }
    const [preexistingWallet] = await db
      .select({ metadata: agentWallets.metadata })
      .from(agentWallets)
      .where(
        and(
          eq(agentWallets.agentId, request.agentId),
          eq(agentWallets.chainFamily, request.chainFamily),
          venue ? eq(agentWallets.venue, venue) : isNull(agentWallets.venue),
        ),
      );
    if (
      preexistingWallet &&
      !isExternalKeyWalletMetadata(preexistingWallet.metadata)
    ) {
      throw new Error(
        "Cannot register external key handle over a server-managed wallet",
      );
    }

    // Provider registration is read-only public-handle validation (no custody
    // state changes) and stays OUTSIDE the lock: network I/O must never hold
    // a transaction-scoped advisory lock.
    const registration = normalizeExternalKeyHandleRegistration(
      request,
      await this.externalKeyCustodyProvider.registerKeyHandle(request),
    );
    const metadata = toExternalKeyWalletMetadata(registration) as Record<
      string,
      unknown
    >;
    const now = new Date();

    await db.transaction(async (tx) => {
      // The custody guards below run under DB serialization — a concurrent
      // importKey (or a second handle import)
      // for the same (agent, chain family, venue) scope could interleave
      // between the checks and the wallet write, leaving both a
      // server-managed key and an external-custody wallet row. Serialize
      // custody transitions per scope and run every guard INSIDE the lock so
      // the interleave fails closed. Skipped on single-connection PGlite,
      // where transactions already serialize.
      if (usesCustodyAdvisoryLock()) {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${custodyTransitionLockKey(request.tenantId, request.agentId, request.chainFamily, venue)}, 0))`,
        );
      }

      if (!venue && request.chainFamily === "evm") {
        const [legacyKey] = await tx
          .select({ agentId: encryptedKeys.agentId })
          .from(encryptedKeys)
          .where(eq(encryptedKeys.agentId, request.agentId));
        if (legacyKey) {
          throw new Error(
            "Cannot register external key handle over a legacy server-managed key",
          );
        }
      }

      const [existingEncryptedKey] = await tx
        .select({ id: encryptedChainKeys.id })
        .from(encryptedChainKeys)
        .where(
          and(
            eq(encryptedChainKeys.agentId, request.agentId),
            eq(encryptedChainKeys.chainFamily, request.chainFamily),
            venue
              ? eq(encryptedChainKeys.venue, venue)
              : isNull(encryptedChainKeys.venue),
          ),
        );
      if (existingEncryptedKey) {
        throw new Error(
          "Cannot register external key handle over a server-managed signing key",
        );
      }

      const [existingWallet] = await tx
        .select({ id: agentWallets.id, metadata: agentWallets.metadata })
        .from(agentWallets)
        .where(
          and(
            eq(agentWallets.agentId, request.agentId),
            eq(agentWallets.chainFamily, request.chainFamily),
            venue ? eq(agentWallets.venue, venue) : isNull(agentWallets.venue),
          ),
        );
      if (
        existingWallet &&
        !isExternalKeyWalletMetadata(existingWallet.metadata)
      ) {
        throw new Error(
          "Cannot register external key handle over a server-managed wallet",
        );
      }

      if (existingWallet) {
        await tx
          .update(agentWallets)
          .set({
            address: registration.address,
            purpose: registration.purpose,
            metadata,
          })
          .where(eq(agentWallets.id, existingWallet.id));
      } else {
        await tx.insert(agentWallets).values({
          agentId: registration.agentId,
          chainFamily: registration.chainFamily,
          venue,
          purpose: registration.purpose,
          address: registration.address,
          metadata,
          createdAt: now,
        });
      }
    });

    return registration;
  }

  async registerExternalKeyHandle(
    request: ExternalKeyHandleImportRequest,
  ): Promise<ExternalKeyHandleRegistration> {
    return this.importExternalKeyHandle(request);
  }

  /**
   * Sign an arbitrary message. Routes to Solana Ed25519 or EVM ECDSA
   * based on the agent's wallet address format.
   */
  async signMessage(
    tenantId: string,
    agentId: string,
    message: string,
  ): Promise<string> {
    const db = getDb();

    // Verify agent exists for this tenant
    const [agentRow] = await db
      .select({ walletAddress: agents.walletAddress })
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.tenantId, tenantId)));

    if (!agentRow) {
      throw new Error(`Agent ${agentId} not found for tenant ${tenantId}`);
    }

    const isSolana = detectChainType(agentRow.walletAddress) === "solana";
    const chainFamilyToUse = isSolana ? "solana" : "evm";
    await assertVaultSigningActive({
      tenantId,
      agentId,
      chainFamily: chainFamilyToUse,
    });
    await this.assertLocalSigningScopeIsNotExternal(agentId, chainFamilyToUse);

    // Resolve signing key: prefer encryptedChainKeys (multi-wallet), fall back to legacy encryptedKeys
    let secretKey: string;
    const [chainKey] = await db
      .select()
      .from(encryptedChainKeys)
      .where(
        and(
          eq(encryptedChainKeys.agentId, agentId),
          eq(encryptedChainKeys.chainFamily, chainFamilyToUse),
          // Legacy lookup, NULL-venue only.
          isNull(encryptedChainKeys.venue),
        ),
      );

    if (chainKey) {
      secretKey = await this.keyStore.decrypt(
        {
          ciphertext: chainKey.ciphertext,
          iv: chainKey.iv,
          tag: chainKey.tag,
          salt: chainKey.salt,
        },
        { tenantId, agentId, chainFamily: chainFamilyToUse, venue: null },
      );
    } else {
      // Fallback: legacy encrypted_keys table
      const [legacyKey] = await db
        .select()
        .from(encryptedKeys)
        .where(eq(encryptedKeys.agentId, agentId));
      if (!legacyKey) {
        throw new Error(`No signing key found for agent ${agentId}`);
      }
      secretKey = await this.keyStore.decrypt(legacyKey as EncryptedKey, {
        tenantId,
        agentId,
        chainFamily: chainFamilyToUse,
        venue: null,
      });
    }

    if (isSolana) {
      return signSolanaMessage(secretKey, message);
    }

    const account = privateKeyToAccount(secretKey as `0x${string}`);
    const signature = await account.signMessage({ message });
    return signature;
  }

  /**
   * Sign a pre-hashed 32-byte EVM digest with the agent's secp256k1 key.
   * This is intentionally lower-level than signMessage and must remain guarded
   * at API edges because raw signatures bypass transaction/message semantics.
   */
  async signRawHash(
    tenantId: string,
    agentId: string,
    hash: `0x${string}`,
  ): Promise<{
    signature: string;
    hash: `0x${string}`;
    walletAddress: string;
  }> {
    if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) {
      throw new Error("hash must be a 32-byte hex string");
    }

    const db = getDb();
    const [agentRow] = await db
      .select({ walletAddress: agents.walletAddress })
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.tenantId, tenantId)));

    if (!agentRow) {
      throw new Error(`Agent ${agentId} not found for tenant ${tenantId}`);
    }
    if (detectChainType(agentRow.walletAddress) !== "evm") {
      throw new Error("Raw secp256k1 signing requires an EVM agent");
    }
    await assertVaultSigningActive({ tenantId, agentId, chainFamily: "evm" });
    await this.assertLocalSigningScopeIsNotExternal(agentId, "evm");

    let secretKey: string;
    const [chainKey] = await db
      .select()
      .from(encryptedChainKeys)
      .where(
        and(
          eq(encryptedChainKeys.agentId, agentId),
          eq(encryptedChainKeys.chainFamily, "evm"),
          isNull(encryptedChainKeys.venue),
        ),
      );

    if (chainKey) {
      secretKey = await this.keyStore.decrypt(
        {
          ciphertext: chainKey.ciphertext,
          iv: chainKey.iv,
          tag: chainKey.tag,
          salt: chainKey.salt,
        },
        { tenantId, agentId, chainFamily: "evm", venue: null },
      );
    } else {
      const [legacyKey] = await db
        .select()
        .from(encryptedKeys)
        .where(eq(encryptedKeys.agentId, agentId));
      if (!legacyKey) {
        throw new Error(`No EVM signing key for agent ${agentId}`);
      }
      secretKey = await this.keyStore.decrypt(legacyKey as EncryptedKey, {
        tenantId,
        agentId,
        chainFamily: "evm",
        venue: null,
      });
    }

    const account = privateKeyToAccount(secretKey as `0x${string}`);
    return {
      signature: await account.sign({ hash }),
      hash,
      walletAddress: account.address,
    };
  }

  /**
   * Sign a raw 32-byte digest across signature curves. This is the cross-curve
   * generalization of {@link signRawHash} and is intentionally lower-level than
   * the transaction/message signers — it MUST stay guarded at API edges because
   * raw signatures bypass transaction and message policy semantics.
   *
   * Curve dispatch (all require an exactly-32-byte payload so the edge cannot be
   * abused to blind-sign a full transaction message):
   *  - `secp256k1` → agent's EVM key, recoverable ECDSA via viem `account.sign`.
   *  - `ed25519`   → agent's Solana key, detached Ed25519 over the 32 bytes.
   *  - `stark`     → fail closed. No vetted starknet curve library is installed,
   *                  and hand-rolling curve crypto in a money path is unacceptable.
   */
  async signRawDigest(
    tenantId: string,
    agentId: string,
    curve: "secp256k1" | "ed25519" | "stark",
    payloadHex: string,
  ): Promise<{
    signature: string;
    curve: "secp256k1" | "ed25519";
    payloadHex: `0x${string}`;
    publicKey: string;
  }> {
    if (curve === "stark") {
      throw new Error(
        "stark curve raw signing is disabled: no vetted starknet signing library is installed",
      );
    }
    if (curve !== "secp256k1" && curve !== "ed25519") {
      throw new Error(`Unsupported raw-sign curve: ${String(curve)}`);
    }

    // Normalize + validate: a raw digest is exactly 32 bytes (64 hex chars).
    const normalized = payloadHex.startsWith("0x")
      ? payloadHex.slice(2)
      : payloadHex;
    if (!/^[0-9a-fA-F]{64}$/.test(normalized)) {
      throw new Error("payloadHex must be a 32-byte hex string");
    }
    const payloadHex0x = `0x${normalized.toLowerCase()}` as `0x${string}`;

    const db = getDb();
    const [agentRow] = await db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.tenantId, tenantId)));
    if (!agentRow) {
      throw new Error(`Agent ${agentId} not found for tenant ${tenantId}`);
    }

    // Curve selects which key family signs: secp256k1 → the agent's EVM key,
    // ed25519 → the agent's Solana key. An agent provisioned via createAgent
    // owns both, so we resolve the requested family directly rather than gating
    // on the agent's "primary" wallet address. The tenant scoping above is the
    // authorization boundary (the encrypted-key tables are keyed by agentId).
    const chainFamily = curve === "secp256k1" ? "evm" : "solana";
    await assertVaultSigningActive({ tenantId, agentId, chainFamily });
    await this.assertLocalSigningScopeIsNotExternal(agentId, chainFamily);

    let secretKey: string;
    const [chainKey] = await db
      .select()
      .from(encryptedChainKeys)
      .where(
        and(
          eq(encryptedChainKeys.agentId, agentId),
          eq(encryptedChainKeys.chainFamily, chainFamily),
          isNull(encryptedChainKeys.venue),
        ),
      );
    if (chainKey) {
      secretKey = await this.keyStore.decrypt(
        {
          ciphertext: chainKey.ciphertext,
          iv: chainKey.iv,
          tag: chainKey.tag,
          salt: chainKey.salt,
        },
        { tenantId, agentId, chainFamily, venue: null },
      );
    } else if (curve === "secp256k1") {
      // Legacy encrypted_keys holds the EVM key only — a safe fallback for
      // secp256k1. NEVER fall back here for ed25519: it would decrypt the EVM
      // key under a Solana chainFamily context and produce a bogus signer.
      const [legacyKey] = await db
        .select()
        .from(encryptedKeys)
        .where(eq(encryptedKeys.agentId, agentId));
      if (!legacyKey) {
        throw new Error(`No evm signing key for agent ${agentId}`);
      }
      secretKey = await this.keyStore.decrypt(legacyKey as EncryptedKey, {
        tenantId,
        agentId,
        chainFamily: "evm",
        venue: null,
      });
    } else {
      throw new Error(`No solana signing key for agent ${agentId}`);
    }

    if (curve === "ed25519") {
      // Decode the validated 64-char hex to 32 bytes without depending on the
      // Buffer global (vault.ts otherwise avoids Node globals).
      const payloadBytes = new Uint8Array(32);
      for (let i = 0; i < 32; i++) {
        payloadBytes[i] = Number.parseInt(
          normalized.slice(i * 2, i * 2 + 2),
          16,
        );
      }
      const { signature, publicKey } = signEd25519Digest(
        secretKey,
        payloadBytes,
      );
      return { signature, curve, payloadHex: payloadHex0x, publicKey };
    }

    const account = privateKeyToAccount(secretKey as `0x${string}`);
    return {
      signature: await account.sign({ hash: payloadHex0x }),
      curve,
      payloadHex: payloadHex0x,
      publicKey: account.address,
    };
  }

  /**
   * Sign an EIP-7702 set-code authorization. Lets an EOA temporarily delegate
   * execution to smart-contract code per transaction (Pectra, May 2025).
   * Returns { contractAddress, chainId, nonce, r, s, yParity, v } which the
   * caller attaches to the `authorizationList` of a type-4 transaction.
   *
   * Per EIP-7702, signing chainId=0 designates "any chain" - useful when the
   * delegation target is chain-agnostic. The vault accepts 0 explicitly so
   * callers can opt in; default is the chainId on the request.
   */
  async signAuthorization(
    tenantId: string,
    agentId: string,
    params: { contractAddress: `0x${string}`; chainId: number; nonce: number },
  ): Promise<{
    contractAddress: `0x${string}`;
    chainId: number;
    nonce: number;
    r: `0x${string}`;
    s: `0x${string}`;
    yParity: 0 | 1;
  }> {
    if (!/^0x[0-9a-fA-F]{40}$/.test(params.contractAddress)) {
      throw new Error("contractAddress must be a 20-byte hex address");
    }
    if (!Number.isInteger(params.chainId) || params.chainId < 0) {
      throw new Error("chainId must be a non-negative integer (0 = any chain)");
    }
    if (!Number.isInteger(params.nonce) || params.nonce < 0) {
      throw new Error("nonce must be a non-negative integer");
    }

    const db = getDb();
    const [agentRow] = await db
      .select({ walletAddress: agents.walletAddress })
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.tenantId, tenantId)));
    if (!agentRow)
      throw new Error(`Agent ${agentId} not found for tenant ${tenantId}`);
    if (detectChainType(agentRow.walletAddress) !== "evm") {
      throw new Error("signAuthorization requires an EVM agent");
    }
    await assertVaultSigningActive({ tenantId, agentId, chainFamily: "evm" });
    await this.assertLocalSigningScopeIsNotExternal(agentId, "evm");

    let secretKey: string;
    const [chainKey] = await db
      .select()
      .from(encryptedChainKeys)
      .where(
        and(
          eq(encryptedChainKeys.agentId, agentId),
          eq(encryptedChainKeys.chainFamily, "evm"),
          isNull(encryptedChainKeys.venue),
        ),
      );
    if (chainKey) {
      secretKey = await this.keyStore.decrypt(
        {
          ciphertext: chainKey.ciphertext,
          iv: chainKey.iv,
          tag: chainKey.tag,
          salt: chainKey.salt,
        },
        { tenantId, agentId, chainFamily: "evm", venue: null },
      );
    } else {
      const [legacyKey] = await db
        .select()
        .from(encryptedKeys)
        .where(eq(encryptedKeys.agentId, agentId));
      if (!legacyKey)
        throw new Error(`No EVM signing key for agent ${agentId}`);
      secretKey = await this.keyStore.decrypt(legacyKey as EncryptedKey, {
        tenantId,
        agentId,
        chainFamily: "evm",
        venue: null,
      });
    }

    const account = privateKeyToAccount(secretKey as `0x${string}`);
    const signed = await account.signAuthorization({
      contractAddress: params.contractAddress,
      chainId: params.chainId,
      nonce: params.nonce,
    });
    return {
      contractAddress: params.contractAddress,
      chainId: params.chainId,
      nonce: params.nonce,
      r: signed.r as `0x${string}`,
      s: signed.s as `0x${string}`,
      yParity: signed.yParity as 0 | 1,
    };
  }

  /**
   * Sign EIP-712 typed data (`eth_signTypedData_v4`).
   * Used for DEX approvals, ERC-20 permits, and structured data signatures.
   */
  async signTypedData(request: SignTypedDataRequest): Promise<string> {
    const db = getDb();

    // Verify agent exists for this tenant
    const [agentRow] = await db
      .select({ walletAddress: agents.walletAddress })
      .from(agents)
      .where(
        and(
          eq(agents.id, request.agentId),
          eq(agents.tenantId, request.tenantId),
        ),
      );

    if (!agentRow) {
      throw new Error(
        `Agent ${request.agentId} not found for tenant ${request.tenantId}`,
      );
    }

    if (detectChainType(agentRow.walletAddress) === "solana") {
      throw new Error(
        "EIP-712 typed data signing is not supported for Solana wallets",
      );
    }
    await assertVaultSigningActive({
      tenantId: request.tenantId,
      agentId: request.agentId,
      chainFamily: "evm",
      venue: request.venue ?? null,
    });
    await this.assertLocalSigningScopeIsNotExternal(
      request.agentId,
      "evm",
      request.venue ?? null,
    );

    // Resolve signing key: prefer encryptedChainKeys (multi-wallet), scoped by
    // venue when requested, then fall back to legacy encryptedKeys only for
    // legacy NULL-venue requests.
    let secretKey: string;
    const [chainKey] = await db
      .select()
      .from(encryptedChainKeys)
      .where(
        and(
          eq(encryptedChainKeys.agentId, request.agentId),
          eq(encryptedChainKeys.chainFamily, "evm"),
          request.venue
            ? eq(encryptedChainKeys.venue, request.venue)
            : isNull(encryptedChainKeys.venue),
        ),
      );

    if (chainKey) {
      secretKey = await this.keyStore.decrypt(
        {
          ciphertext: chainKey.ciphertext,
          iv: chainKey.iv,
          tag: chainKey.tag,
          salt: chainKey.salt,
        },
        {
          tenantId: request.tenantId,
          agentId: request.agentId,
          chainFamily: "evm",
          venue: request.venue ?? null,
        },
      );
    } else {
      if (request.venue) {
        throw new Error(
          `No signing key found for agent ${request.agentId} on venue ${request.venue}`,
        );
      }
      // Fallback: legacy encrypted_keys table
      const [legacyKey] = await db
        .select()
        .from(encryptedKeys)
        .where(eq(encryptedKeys.agentId, request.agentId));
      if (!legacyKey) {
        throw new Error(`No signing key found for agent ${request.agentId}`);
      }
      secretKey = await this.keyStore.decrypt(legacyKey as EncryptedKey, {
        tenantId: request.tenantId,
        agentId: request.agentId,
        chainFamily: "evm",
        venue: null,
      });
    }

    const account = privateKeyToAccount(secretKey as `0x${string}`);

    const signature = await account.signTypedData({
      domain: {
        name: request.domain.name,
        version: request.domain.version,
        chainId: request.domain.chainId,
        verifyingContract: request.domain.verifyingContract as
          | `0x${string}`
          | undefined,
        salt: request.domain.salt as `0x${string}` | undefined,
      },
      types: request.types as Record<
        string,
        Array<{ name: string; type: string }>
      >,
      primaryType: request.primaryType,
      message: request.value,
    });

    return signature;
  }

  /**
   * Sign an ERC-4337 EntryPoint v0.7 user operation hash with the agent's EVM key.
   * The signature is EIP-191-prefixed, which matches common account implementations.
   */
  async signUserOperation(request: {
    agentId: string;
    tenantId: string;
    userOperation: UnpackedUserOperationFields;
    entryPoint?: `0x${string}`;
    chainId: number;
  }): Promise<{
    signature: string;
    userOperationHash: string;
    entryPoint: string;
    chainId: number;
  }> {
    const db = getDb();

    const [agentRow] = await db
      .select({ walletAddress: agents.walletAddress })
      .from(agents)
      .where(
        and(
          eq(agents.id, request.agentId),
          eq(agents.tenantId, request.tenantId),
        ),
      );

    if (!agentRow) {
      throw new Error(
        `Agent ${request.agentId} not found for tenant ${request.tenantId}`,
      );
    }

    if (detectChainType(agentRow.walletAddress) === "solana") {
      throw new Error(
        "ERC-4337 user operation signing is not supported for Solana wallets",
      );
    }
    await this.assertLocalSigningScopeIsNotExternal(request.agentId, "evm");

    await assertVaultSigningActive({
      tenantId: request.tenantId,
      agentId: request.agentId,
      chainFamily: "evm",
      venue: null,
    });

    const [chainKey] = await db
      .select()
      .from(encryptedChainKeys)
      .where(
        and(
          eq(encryptedChainKeys.agentId, request.agentId),
          eq(encryptedChainKeys.chainFamily, "evm"),
          isNull(encryptedChainKeys.venue),
        ),
      );

    let secretKey: string;
    if (chainKey) {
      secretKey = await this.keyStore.decrypt(
        {
          ciphertext: chainKey.ciphertext,
          iv: chainKey.iv,
          tag: chainKey.tag,
          salt: chainKey.salt,
        },
        {
          tenantId: request.tenantId,
          agentId: request.agentId,
          chainFamily: "evm",
          venue: null,
        },
      );
    } else {
      const [legacyKey] = await db
        .select()
        .from(encryptedKeys)
        .where(eq(encryptedKeys.agentId, request.agentId));
      if (!legacyKey) {
        throw new Error(`No signing key found for agent ${request.agentId}`);
      }
      secretKey = await this.keyStore.decrypt(legacyKey as EncryptedKey, {
        tenantId: request.tenantId,
        agentId: request.agentId,
        chainFamily: "evm",
        venue: null,
      });
    }

    const entryPoint = request.entryPoint ?? ENTRY_POINT_V07;
    const packed = packUserOperation(request.userOperation);
    const userOperationHash = getUserOperationHash(
      packed,
      entryPoint,
      request.chainId,
    );
    const account = privateKeyToAccount(secretKey as `0x${string}`);
    const signature = await account.signMessage({
      message: { raw: userOperationHash },
    });

    return {
      signature,
      userOperationHash,
      entryPoint,
      chainId: request.chainId,
    };
  }

  /**
   * Sign a serialized Solana transaction.
   * Accepts a base64-encoded transaction, signs it with the agent's Ed25519 key,
   * and optionally broadcasts it.
   *
   * Works for both multi-wallet agents (new) and legacy Solana-only agents.
   */
  async signSolanaTransaction(request: SignSolanaTransactionRequest): Promise<{
    signature: string;
    broadcast: boolean;
    chainId: number;
    caip2?: string;
  }> {
    const db = getDb();

    // Verify agent exists
    const [agentRow] = await db
      .select({ walletAddress: agents.walletAddress })
      .from(agents)
      .where(
        and(
          eq(agents.id, request.agentId),
          eq(agents.tenantId, request.tenantId),
        ),
      );

    if (!agentRow) {
      throw new Error(
        `Agent ${request.agentId} not found for tenant ${request.tenantId}`,
      );
    }
    await this.assertLocalSigningScopeIsNotExternal(request.agentId, "solana");

    await assertVaultSigningActive({
      tenantId: request.tenantId,
      agentId: request.agentId,
      chainFamily: "solana",
      venue: null,
    });

    // SEC-163: fail closed on blind signing. Without the expectedTo/
    // expectedValue envelope the vault applies no recipient/amount assertion,
    // so the caller must explicitly attest that its own edge policy evaluation
    // approved the transaction. Checked after the signing freeze (a freeze
    // must still report as a freeze) and before any key material is touched.
    if (
      request.expectedTo === undefined &&
      request.expectedValue === undefined
    ) {
      if (request.allowBlindSign !== true) {
        throw new Error(
          "Solana transaction signing without a policy envelope requires allowBlindSign: true " +
            "(caller attestation that edge policy approved the transaction)",
        );
      }
      logger.warn(
        {
          details: [
            `[Vault] BLIND Solana sign (no policy envelope, caller-attested): tenant=${request.tenantId} agent=${request.agentId} chainId=${request.chainId ?? 101} broadcast=${request.broadcast !== false}`,
          ],
        },
        "[Login:vault] warn",
      );
    }

    // Resolve Solana key: prefer encryptedChainKeys (multi-wallet), fall back to
    // legacy encryptedKeys when the agent has a Solana walletAddress.
    let secretKey: string;
    const [chainKey] = await db
      .select()
      .from(encryptedChainKeys)
      .where(
        and(
          eq(encryptedChainKeys.agentId, request.agentId),
          eq(encryptedChainKeys.chainFamily, "solana"),
          isNull(encryptedChainKeys.venue),
        ),
      );

    if (chainKey) {
      secretKey = await this.keyStore.decrypt(
        {
          ciphertext: chainKey.ciphertext,
          iv: chainKey.iv,
          tag: chainKey.tag,
          salt: chainKey.salt,
        },
        {
          tenantId: request.tenantId,
          agentId: request.agentId,
          chainFamily: "solana",
          venue: null,
        },
      );
    } else {
      // Legacy path: only works if the walletAddress is a Solana address
      if (detectChainType(agentRow.walletAddress) !== "solana") {
        throw new Error(
          "Solana transaction signing requires a Solana wallet. This agent only has an EVM wallet.",
        );
      }
      const [legacyKey] = await db
        .select()
        .from(encryptedKeys)
        .where(eq(encryptedKeys.agentId, request.agentId));
      if (!legacyKey) {
        throw new Error(
          `No Solana signing key found for agent ${request.agentId}`,
        );
      }
      secretKey = await this.keyStore.decrypt(legacyKey as EncryptedKey, {
        tenantId: request.tenantId,
        agentId: request.agentId,
        chainFamily: "solana",
        venue: null,
      });
    }

    const keypair = restoreSolanaKeypair(secretKey);
    const chainId = request.chainId ?? 101;
    const rpcUrl = this.config.rpcUrl ?? resolveSolanaRpc(chainId);
    const shouldBroadcast = request.broadcast !== false;

    // Deserialize the transaction (legacy OR v0/versioned). A versioned message
    // sets the high bit of its first byte; legacy Transaction.from() throws on it
    // ("Versioned messages must be deserialized with VersionedMessage..."), so
    // every v0 tx — the modern default, mandatory for address-lookup-table DeFi
    // like Jupiter — would 500 at signing after passing the (version-aware)
    // policy gate. Branch on the version byte so both shapes sign.
    const {
      Transaction: SolTransaction,
      VersionedTransaction,
      Connection,
      SendTransactionError,
    } = await import("@solana/web3.js");
    const txBytes = Uint8Array.from(atob(request.transaction), (c) =>
      c.charCodeAt(0),
    );

    const requireEnvelope = (): {
      from: string;
      to: string;
      lamports: bigint;
    } | null => {
      if (
        request.expectedTo === undefined &&
        request.expectedValue === undefined
      )
        return null;
      if (
        request.expectedTo === undefined ||
        request.expectedValue === undefined
      ) {
        throw new Error(
          "Solana transaction policy envelope requires expectedTo and expectedValue",
        );
      }
      return {
        from: keypair.publicKey.toBase58(),
        to: request.expectedTo,
        lamports: BigInt(request.expectedValue),
      };
    };

    let signedBytes: Uint8Array;
    let preparedSignature: string;
    let recentBlockhash: string;
    if (isVersionedTransactionBytes(txBytes)) {
      const vtx = VersionedTransaction.deserialize(txBytes);
      assertSolanaPriorityFeeWithinCap(
        parseSolanaTransaction(request.transaction),
      );
      const envelope = requireEnvelope();
      if (envelope) {
        // The byte-level legacy assertion can't read a v0 message; verify the
        // envelope via the version-aware parser instead.
        assertParsedSolanaTransferMatches(request.transaction, envelope);
      }
      vtx.sign([keypair]);
      signedBytes = vtx.serialize();
      const signature = vtx.signatures[0];
      if (!signature?.some((byte) => byte !== 0)) {
        throw new Error(
          "Solana versioned transaction did not produce a signer signature",
        );
      }
      preparedSignature = bs58.encode(signature);
      recentBlockhash = vtx.message.recentBlockhash;
    } else {
      const tx = SolTransaction.from(txBytes);
      assertSolanaPriorityFeeWithinCap(
        parseSolanaTransaction(request.transaction),
      );
      const envelope = requireEnvelope();
      if (envelope) {
        assertSolanaTransferTransactionMatches(tx, {
          from: keypair.publicKey,
          to: envelope.to,
          lamports: envelope.lamports,
        });
      }
      tx.partialSign(keypair);
      signedBytes = tx.serialize();
      if (!tx.signature) {
        throw new Error(
          "Solana transaction did not produce a signer signature",
        );
      }
      preparedSignature = bs58.encode(tx.signature);
      if (!tx.recentBlockhash) {
        throw new Error("Solana transaction is missing a recent blockhash");
      }
      recentBlockhash = tx.recentBlockhash;
    }

    if (shouldBroadcast) {
      // Persist the deterministic signature before the first external write.
      // A checkpoint failure aborts safely before sendRawTransaction.
      await request.onBroadcastPrepared?.({
        signature: preparedSignature,
        recentBlockhash,
      });
      const connection = new Connection(rpcUrl, "confirmed");
      try {
        const sig = await connection.sendRawTransaction(signedBytes, {
          skipPreflight: false,
          preflightCommitment: "confirmed",
        });
        if (sig !== preparedSignature) {
          throw new Error(
            "Solana RPC returned a signature that does not match the signed bytes",
          );
        }
        await connection.confirmTransaction(sig, "confirmed");
      } catch (error) {
        // The signed bytes and their deterministic signature were durably
        // checkpointed before sendRawTransaction. Its rejection may represent
        // a preflight denial, an accepted submission with a lost response, or
        // a later confirmation failure, so every case is conservatively
        // non-retryable until the signature is reconciled.
        if (
          error instanceof SendTransactionError &&
          error.message.startsWith("Simulation failed.")
        ) {
          throw new SolanaBroadcastNotSubmittedError(preparedSignature, {
            cause: error,
          });
        }
        throw new ExternalBroadcastOutcomeUnknownError(preparedSignature, {
          cause: error,
        });
      }

      return {
        signature: preparedSignature,
        broadcast: true,
        chainId,
        caip2: toCaip2(chainId),
      };
    }

    // Return serialized signed transaction as base64
    const serialized = btoa(
      Array.from(signedBytes, (b) => String.fromCharCode(b)).join(""),
    );
    return {
      signature: serialized,
      broadcast: false,
      chainId,
      caip2: toCaip2(chainId),
    };
  }

  async reconcileSolanaBroadcast(input: {
    signature: string;
    recentBlockhash: string;
    chainId?: number;
  }): Promise<"confirmed" | "broadcast" | "failed" | "outcome_unknown"> {
    const { Connection } = await import("@solana/web3.js");
    const rpcUrl = this.config.rpcUrl ?? resolveSolanaRpc(input.chainId ?? 101);
    const connection = new Connection(rpcUrl, "confirmed");
    const response = await connection.getSignatureStatuses([input.signature], {
      searchTransactionHistory: true,
    });
    const status = response.value[0];
    if (status) {
      if (status.err !== null) return "failed";
      if (
        status.confirmationStatus === "confirmed" ||
        status.confirmationStatus === "finalized"
      ) {
        return "confirmed";
      }
      return "broadcast";
    }
    const validity = await connection.isBlockhashValid(input.recentBlockhash, {
      commitment: "confirmed",
    });
    return validity.value ? "outcome_unknown" : "failed";
  }

  /**
   * Export the decrypted private keys for an agent.
   * Returns both EVM and Solana keys where available.
   * The caller is responsible for securing the returned material.
   */
  async exportPrivateKey(
    tenantId: string,
    agentId: string,
    authorization?: ExportPrivateKeyAuthorization,
  ): Promise<ExportPrivateKeyResult> {
    // Defense-in-depth: this returns plaintext key material, so it must never be
    // invoked casually. Require an explicit break-glass authorization context that
    // the (admin + MFA + audited) caller constructs, and emit a log entry every time.
    if (!authorization?.breakGlass || !authorization.actorId?.trim()) {
      throw new Error(
        "exportPrivateKey requires an explicit break-glass authorization { breakGlass: true, actorId }",
      );
    }
    logger.warn(
      {
        details: [
          `[Vault] BREAK-GLASS private key export: tenant=${tenantId} agent=${agentId} actor=${authorization.actorId} reason=${authorization.reason ?? "unspecified"}`,
        ],
      },
      "[Login:vault] warn",
    );

    const db = getDb();

    // Verify agent belongs to this tenant
    const [agentRow] = await db
      .select({ id: agents.id, tenantId: agents.tenantId })
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.tenantId, tenantId)));

    if (!agentRow) {
      throw new Error(`Agent ${agentId} not found for tenant ${tenantId}`);
    }
    await this.assertNoExternalKeyWalletsForExport(agentId);

    const result: ExportPrivateKeyResult = {};

    // ── Get EVM key (prefer multi-chain table, fall back to legacy) ──────
    const [evmChainKey] = await db
      .select()
      .from(encryptedChainKeys)
      .where(
        and(
          eq(encryptedChainKeys.agentId, agentId),
          eq(encryptedChainKeys.chainFamily, "evm"),
          isNull(encryptedChainKeys.venue),
        ),
      );

    if (evmChainKey) {
      const pk = await this.keyStore.decrypt(
        {
          ciphertext: evmChainKey.ciphertext,
          iv: evmChainKey.iv,
          tag: evmChainKey.tag,
          salt: evmChainKey.salt,
        },
        { tenantId, agentId, chainFamily: "evm", venue: null },
      );
      const [evmWallet] = await db
        .select({ address: agentWallets.address })
        .from(agentWallets)
        .where(
          and(
            eq(agentWallets.agentId, agentId),
            eq(agentWallets.chainFamily, "evm"),
            isNull(agentWallets.venue),
          ),
        );
      result.evm = {
        privateKey: pk,
        address:
          evmWallet?.address ??
          privateKeyToAccount(pk as `0x${string}`).address,
      };
    } else {
      // Legacy: encrypted_keys table (EVM only)
      const [legacyKey] = await db
        .select()
        .from(encryptedKeys)
        .where(eq(encryptedKeys.agentId, agentId));
      if (legacyKey) {
        const pk = await this.keyStore.decrypt(legacyKey as EncryptedKey, {
          tenantId,
          agentId,
          chainFamily: "evm",
          venue: null,
        });
        result.evm = {
          privateKey: pk,
          address: privateKeyToAccount(pk as `0x${string}`).address,
        };
      }
    }

    // ── Get Solana key ───────────────────────────────────────────────────
    const [solChainKey] = await db
      .select()
      .from(encryptedChainKeys)
      .where(
        and(
          eq(encryptedChainKeys.agentId, agentId),
          eq(encryptedChainKeys.chainFamily, "solana"),
          isNull(encryptedChainKeys.venue),
        ),
      );

    if (solChainKey) {
      const pk = await this.keyStore.decrypt(
        {
          ciphertext: solChainKey.ciphertext,
          iv: solChainKey.iv,
          tag: solChainKey.tag,
          salt: solChainKey.salt,
        },
        { tenantId, agentId, chainFamily: "solana", venue: null },
      );
      const [solWallet] = await db
        .select({ address: agentWallets.address })
        .from(agentWallets)
        .where(
          and(
            eq(agentWallets.agentId, agentId),
            eq(agentWallets.chainFamily, "solana"),
            isNull(agentWallets.venue),
          ),
        );
      result.solana = { privateKey: pk, address: solWallet?.address ?? "" };
    }

    // ── Get Bitcoin scoped keys ──────────────────────────────────────────
    // Bitcoin wallets are always stored as scoped rows because their address
    // metadata includes network/script/path. Return every Bitcoin key under
    // this agent through the same audited break-glass gate.
    const bitcoinChainKeys = await db
      .select()
      .from(encryptedChainKeys)
      .where(
        and(
          eq(encryptedChainKeys.agentId, agentId),
          eq(encryptedChainKeys.chainFamily, "bitcoin"),
        ),
      );

    if (bitcoinChainKeys.length > 0) {
      const bitcoinWalletRows = await db
        .select({
          address: agentWallets.address,
          venue: agentWallets.venue,
          purpose: agentWallets.purpose,
          metadata: agentWallets.metadata,
        })
        .from(agentWallets)
        .where(
          and(
            eq(agentWallets.agentId, agentId),
            eq(agentWallets.chainFamily, "bitcoin"),
          ),
        );
      const walletByVenue = new Map(
        bitcoinWalletRows.map((wallet) => [wallet.venue ?? "", wallet]),
      );

      result.bitcoin = await Promise.all(
        bitcoinChainKeys.map(async (chainKey) => {
          const pk = await this.keyStore.decrypt(
            {
              ciphertext: chainKey.ciphertext,
              iv: chainKey.iv,
              tag: chainKey.tag,
              salt: chainKey.salt,
            },
            {
              tenantId,
              agentId,
              chainFamily: "bitcoin",
              venue: chainKey.venue ?? null,
            },
          );
          const wallet = walletByVenue.get(chainKey.venue ?? "");
          return {
            privateKey: pk,
            address: wallet?.address ?? "",
            venue: chainKey.venue ?? null,
            purpose: chainKey.purpose ?? wallet?.purpose ?? null,
            metadata: (wallet?.metadata ?? {}) as WalletAddressMetadata,
          };
        }),
      );
    }

    // ── Get Monero scoped keys ───────────────────────────────────────────
    // Monero wallets are always scoped rows (venue = monero:<network>:<account>).
    // The exported spend key alone is sufficient to restore the wallet in any
    // Monero wallet software ("restore from keys"); the view key and restore
    // height make the restore instant instead of a full rescan.
    const moneroChainKeys = await db
      .select()
      .from(encryptedChainKeys)
      .where(
        and(
          eq(encryptedChainKeys.agentId, agentId),
          eq(encryptedChainKeys.chainFamily, "monero"),
        ),
      );

    if (moneroChainKeys.length > 0) {
      const moneroWalletRows = await db
        .select({
          address: agentWallets.address,
          venue: agentWallets.venue,
          purpose: agentWallets.purpose,
          metadata: agentWallets.metadata,
        })
        .from(agentWallets)
        .where(
          and(
            eq(agentWallets.agentId, agentId),
            eq(agentWallets.chainFamily, "monero"),
          ),
        );
      const moneroWalletByVenue = new Map(
        moneroWalletRows.map((wallet) => [wallet.venue ?? "", wallet]),
      );

      result.monero = await Promise.all(
        moneroChainKeys.map(async (chainKey) => {
          const serialized = await this.keyStore.decrypt(
            {
              ciphertext: chainKey.ciphertext,
              iv: chainKey.iv,
              tag: chainKey.tag,
              salt: chainKey.salt,
            },
            {
              tenantId,
              agentId,
              chainFamily: "monero",
              venue: chainKey.venue ?? null,
            },
          );
          const payload = parseMoneroKeyPayload(serialized);
          const wallet = moneroWalletByVenue.get(chainKey.venue ?? "");
          return {
            spendKey: payload.spendKey,
            viewKey: payload.viewKey,
            address: payload.address,
            restoreHeight: payload.restoreHeight,
            venue: chainKey.venue ?? null,
            purpose: chainKey.purpose ?? wallet?.purpose ?? null,
            metadata: (wallet?.metadata ?? {}) as WalletAddressMetadata,
          };
        }),
      );
    }

    return result;
  }

  async inspectBitcoinPsbt(
    request: SignBitcoinPsbtRequest,
  ): Promise<InspectBitcoinPsbtResult> {
    const { tenantId, agentId, walletScope, psbtBase64 } = request;
    if (!walletScope?.trim()) {
      throw new Error("Bitcoin PSBT inspection requires a walletScope");
    }
    const db = getDb();

    const [agentRow] = await db
      .select({ id: agents.id, tenantId: agents.tenantId })
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.tenantId, tenantId)));
    if (!agentRow) {
      throw new Error(`Agent ${agentId} not found for tenant ${tenantId}`);
    }

    const walletRows = await db
      .select({
        address: agentWallets.address,
        venue: agentWallets.venue,
        metadata: agentWallets.metadata,
      })
      .from(agentWallets)
      .where(
        and(
          eq(agentWallets.agentId, agentId),
          eq(agentWallets.chainFamily, "bitcoin"),
        ),
      );
    const wallet = walletRows.find((row) => row.venue === walletScope);
    if (!wallet) {
      throw missingSigningKeyError(agentId, "bitcoin", walletScope);
    }

    const inspection = inspectBitcoinPsbtPayload(
      psbtBase64,
      (wallet.metadata ?? {}) as WalletAddressMetadata,
    );
    const metadata = parseBitcoinPsbtSigningMetadata(
      (wallet.metadata ?? {}) as WalletAddressMetadata,
    );
    const sameNetworkWalletAddresses = new Set<string>();
    for (const row of walletRows) {
      try {
        const rowMetadata = parseBitcoinPsbtSigningMetadata(
          (row.metadata ?? {}) as WalletAddressMetadata,
        );
        if (rowMetadata.network === metadata.network) {
          sameNetworkWalletAddresses.add(row.address);
        }
      } catch {
        // Ignore malformed historical metadata when classifying PSBT change outputs.
      }
    }
    const outputs = inspection.outputs.map((output) => ({
      ...output,
      isChange: sameNetworkWalletAddresses.has(output.address),
    }));

    return {
      walletScope,
      walletAddress: wallet.address,
      network: metadata.network,
      outputs,
      inputTotalSats: inspection.inputTotalSats,
      outputTotalSats: inspection.outputTotalSats,
      feeSats: inspection.feeSats,
    };
  }

  async signBitcoinPsbt(
    request: SignBitcoinPsbtRequest,
  ): Promise<SignBitcoinPsbtResult> {
    const { tenantId, agentId, walletScope, psbtBase64, finalize } = request;
    if (!walletScope?.trim()) {
      throw new Error("Bitcoin PSBT signing requires a walletScope");
    }
    const db = getDb();

    const [agentRow] = await db
      .select({ id: agents.id, tenantId: agents.tenantId })
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.tenantId, tenantId)));
    if (!agentRow) {
      throw new Error(`Agent ${agentId} not found for tenant ${tenantId}`);
    }
    await assertVaultSigningActive({
      tenantId,
      agentId,
      chainFamily: "bitcoin",
      venue: walletScope,
    });

    // SEC-163: the vault layer applies no fee/output policy to PSBTs — it
    // signs any PSBT with ≥1 input spendable by the wallet key. Signing is
    // therefore only permitted when the caller explicitly attests that edge
    // policy (inspectBitcoinPsbt + spend/fee evaluation) already approved
    // this exact payload. Checked after the freeze gate, before key access.
    if (request.allowBlindSign !== true) {
      throw new Error(
        "Bitcoin PSBT signing requires allowBlindSign: true " +
          "(caller attestation that edge policy approved the PSBT)",
      );
    }

    const [wallet] = await db
      .select({
        address: agentWallets.address,
        venue: agentWallets.venue,
        metadata: agentWallets.metadata,
      })
      .from(agentWallets)
      .where(
        and(
          eq(agentWallets.agentId, agentId),
          eq(agentWallets.chainFamily, "bitcoin"),
          eq(agentWallets.venue, walletScope),
        ),
      );
    if (!wallet) {
      throw missingSigningKeyError(agentId, "bitcoin", walletScope);
    }

    const [chainKey] = await db
      .select()
      .from(encryptedChainKeys)
      .where(
        and(
          eq(encryptedChainKeys.agentId, agentId),
          eq(encryptedChainKeys.chainFamily, "bitcoin"),
          eq(encryptedChainKeys.venue, walletScope),
        ),
      );
    if (!chainKey) {
      throw missingSigningKeyError(agentId, "bitcoin", walletScope);
    }

    const privateKey = await this.keyStore.decrypt(
      {
        ciphertext: chainKey.ciphertext,
        iv: chainKey.iv,
        tag: chainKey.tag,
        salt: chainKey.salt,
      },
      { tenantId, agentId, chainFamily: "bitcoin", venue: walletScope },
    );
    const signed = signBitcoinPsbt({
      psbtBase64,
      privateKey,
      walletMetadata: (wallet.metadata ?? {}) as WalletAddressMetadata,
      finalize,
    });

    return {
      ...signed,
      walletScope,
      walletAddress: wallet.address,
    };
  }

  /**
   * Read a scoped Monero wallet's balance. Read-only: no signing-freeze gate,
   * but tenant ownership and the AAD-bound key payload are still enforced —
   * scanning requires the (private) view key, which never leaves this host.
   */
  async getMoneroBalance(
    request: GetMoneroBalanceRequest,
  ): Promise<GetMoneroBalanceResult> {
    const { tenantId, agentId, walletScope } = request;
    const backend = this.getMoneroBackend();
    const { payload, walletAddress } = await this.resolveMoneroWallet({
      tenantId,
      agentId,
      walletScope,
    });
    const balance = await backend.getBalance(payload, {
      cacheId: this.moneroCacheId(tenantId, agentId, walletScope),
    });
    return {
      ...balance,
      walletScope,
      walletAddress,
      network: payload.network,
    };
  }

  /**
   * Build + sign (but DO NOT broadcast) a Monero transfer. Two-phase by
   * design: the exact network fee is only known after wallet2 builds the
   * transaction, and the fee-inclusive aggregate policy check must run before
   * anything is relayed. Callers either relayMoneroTransfer() the returned
   * txMetadata or discardMoneroTransfer() on policy denial.
   */
  async prepareMoneroTransfer(
    request: PrepareMoneroTransferRequest,
  ): Promise<PrepareMoneroTransferResult> {
    const { tenantId, agentId, walletScope, destinations, priority } = request;
    const backend = this.getMoneroBackend();
    await assertVaultSigningActive({
      tenantId,
      agentId,
      chainFamily: "monero",
      venue: walletScope,
    });
    const { payload, walletAddress } = await this.resolveMoneroWallet({
      tenantId,
      agentId,
      walletScope,
    });
    if (!Array.isArray(destinations) || destinations.length === 0) {
      throw new Error("Monero transfer requires at least one destination");
    }
    const parsedDestinations = destinations.map((destination) => ({
      address: destination.address,
      amountPiconero: parsePiconeroAmount(destination.amountPiconero),
    }));
    const prepared = await backend.prepareTransfer(
      payload,
      { cacheId: this.moneroCacheId(tenantId, agentId, walletScope) },
      { destinations: parsedDestinations, priority },
    );
    return {
      walletScope,
      walletAddress,
      network: payload.network,
      txMetadata: prepared.txMetadata,
      txHash: prepared.txHash,
      feePiconero: prepared.feePiconero,
      amountPiconero: prepared.amountPiconero,
    };
  }

  /**
   * Broadcast a transfer previously produced by prepareMoneroTransfer. The
   * signing freeze is re-checked so a freeze between prepare and relay still
   * stops the funds from moving.
   */
  async relayMoneroTransfer(
    request: RelayMoneroTransferRequest,
  ): Promise<{ txHash: string }> {
    const { tenantId, agentId, walletScope, txMetadata } = request;
    const backend = this.getMoneroBackend();
    await assertVaultSigningActive({
      tenantId,
      agentId,
      chainFamily: "monero",
      venue: walletScope,
    });
    // Re-verify ownership so a relay can never be replayed across tenants;
    // the backend needs the wallet identity because relay_tx requires the
    // signing wallet to be open in wallet-rpc.
    const { payload } = await this.resolveMoneroWallet({
      tenantId,
      agentId,
      walletScope,
    });
    return backend.relayTransfer(
      payload,
      { cacheId: this.moneroCacheId(tenantId, agentId, walletScope) },
      txMetadata,
    );
  }

  /**
   * Best-effort cache cleanup after a prepared transfer was denied by policy
   * and will never be relayed. Failure is non-fatal: the wallet cache is
   * disposable and self-heals on rehydration.
   */
  async discardMoneroTransfer(request: GetMoneroBalanceRequest): Promise<void> {
    const { tenantId, agentId, walletScope } = request;
    const backend = this.getMoneroBackend();
    const { payload } = await this.resolveMoneroWallet({
      tenantId,
      agentId,
      walletScope,
    });
    await backend.discardPreparedTransfer(payload, {
      cacheId: this.moneroCacheId(tenantId, agentId, walletScope),
    });
  }

  /**
   * Proxy a read-only RPC call to the appropriate chain provider.
   * Supports both EVM and Solana RPC methods.
   *
   * SEC-082: enforced as an ALLOWLIST, not a blocklist. A blocklist can never
   * enumerate every signing/admin method on every upstream (`eth_signTypedData_v3`,
   * Solana `signMessage`/`signTransaction`, or `admin_`/`debug_`/`trace_`
   * namespaces when an operator points `config.rpcUrl` at a node with unlocked
   * accounts), so only known read-only methods pass. Operators tighten or
   * tighten the inventory via STEWARD_VAULT_RPC_ALLOWLIST (comma-separated) —
   * the same knob the API edge uses. Note the vault's own guards proxy
   * `eth_getCode` through here, so an override that omits it fails closed
   * (native-transfer code checks are denied, never bypassed).
   */
  async rpcPassthrough(request: RpcRequest): Promise<RpcResponse> {
    const chainId = request.chainId;
    const isSolana = chainId === 101 || chainId === 102;

    let rpcUrl: string;
    if (isSolana) {
      rpcUrl = SOLANA_RPCS[chainId] ?? SOLANA_RPCS[101];
    } else {
      rpcUrl = CHAIN_RPCS[chainId] ?? this.config.rpcUrl ?? "";
    }

    if (!rpcUrl) {
      throw new Error(`No RPC URL configured for chainId ${chainId}`);
    }

    const configured = process.env.STEWARD_VAULT_RPC_ALLOWLIST;
    const configuredMethods = configured
      ?.split(",")
      .map((method) => method.trim())
      .filter(Boolean);
    if (
      configuredMethods?.some(
        (method) => !DEFAULT_RPC_PASSTHROUGH_METHODS.has(method),
      )
    ) {
      throw new Error(
        "STEWARD_VAULT_RPC_ALLOWLIST contains an unsupported method",
      );
    }
    const allowlist = configuredMethods
      ? new Set(configuredMethods)
      : DEFAULT_RPC_PASSTHROUGH_METHODS;
    if (!allowlist.has(request.method)) {
      throw new Error(
        `Method ${request.method} is not allowed via RPC passthrough - read-only methods only`,
      );
    }

    const response = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: request.method,
        params: request.params ?? [],
      }),
      redirect: "error",
      signal: AbortSignal.timeout(RPC_PASSTHROUGH_TIMEOUT_MS),
    });
    return readBoundedRpcResponse(response);
  }

  // ──────────────────────────────────────────────────────────────────────
  // Venue-scoped wallet API.
  // ──────────────────────────────────────────────────────────────────────
  //
  // Wallets used to be keyed by (agentId, chainFamily). Trade-sessions now
  // need to address them per (agentId, venue) because Sol's BSC wallet
  // and Sol's Hyperliquid wallet sit on the same chainFamily (EVM) but
  // must hold distinct keys. `venue` is optional: legacy callers still
  // pass `chainId` (mapped to chainFamily), which resolves to the
  // NULL-venue row written by `createAgent`.

  /**
   * Look up a wallet for an agent.
   *
   * Priority:
   *   1. If `venue` is provided, return the row with that exact venue. If
   *      no row matches, throw - we never silently downgrade to a legacy
   *      wallet when a venue was explicitly requested.
   *   2. If only `chainId` is provided, map to chainFamily and return the
   *      legacy (venue IS NULL) row for that family. This preserves
   *      backward compat for @stwd/agent-trader and direct SDK callers.
   *
   * Throws if neither is provided, or if no matching row exists.
   */
  async getWallet(args: {
    agentId: string;
    venue?: string;
    scope?: string;
    chainId?: number;
  }): Promise<WalletRowResult> {
    const { agentId, venue, chainId } = args;
    const scope = args.scope ?? venue;
    if (!scope && chainId === undefined) {
      throw new Error(
        "getWallet requires either `venue`, `scope`, or `chainId`",
      );
    }

    const db = getDb();

    if (scope) {
      const [row] = await db
        .select()
        .from(agentWallets)
        .where(
          and(eq(agentWallets.agentId, agentId), eq(agentWallets.venue, scope)),
        );

      if (!row) {
        throw new Error(
          `No wallet found for agent ${agentId} on venue ${scope}`,
        );
      }
      return {
        agentId: row.agentId,
        chainFamily: row.chainFamily as WalletChainFamily,
        venue: row.venue,
        purpose: row.purpose,
        address: row.address,
        metadata: row.metadata,
      };
    }

    // Legacy fallback: chainId → chainFamily, then look up the NULL-venue row.
    const chainFamily = chainIdToChainFamily(chainId as number);
    const [row] = await db
      .select()
      .from(agentWallets)
      .where(
        and(
          eq(agentWallets.agentId, agentId),
          eq(agentWallets.chainFamily, chainFamily),
          isNull(agentWallets.venue),
        ),
      );

    if (!row) {
      throw new Error(
        `No legacy wallet found for agent ${agentId} on chain family ${chainFamily}`,
      );
    }
    return {
      agentId: row.agentId,
      chainFamily: row.chainFamily as WalletChainFamily,
      venue: row.venue,
      purpose: row.purpose,
      address: row.address,
      metadata: row.metadata,
    };
  }

  /**
   * Provision a fresh, venue-scoped wallet for an agent with default safety
   * policies attached in the same DB transaction.
   *
   * This is the preferred onboarding path for venue wallets: the wallet is
   * never born without its venue allowlist, leverage cap, spend limits, and
   * withdrawal destination allowlist enabled.
   */
  async provisionVenueWallet(args: {
    tenantId: string;
    agentId: string;
    venue: string;
    chainFamily: "evm" | "solana";
    approvedAddresses: string[];
  }): Promise<{ address: string }> {
    const { tenantId, agentId, venue, chainFamily, approvedAddresses } = args;
    if (!tenantId) throw new Error("provisionVenueWallet requires a tenantId");
    if (!agentId) throw new Error("provisionVenueWallet requires an agentId");
    if (!venue) throw new Error("provisionVenueWallet requires a venue");
    if (chainFamily !== "evm" && chainFamily !== "solana") {
      throw new Error(
        `provisionVenueWallet: unsupported chainFamily ${chainFamily}`,
      );
    }
    if (!Array.isArray(approvedAddresses)) {
      throw new Error("provisionVenueWallet requires approvedAddresses");
    }

    const db = getDb();

    const [agentRow] = await db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.tenantId, tenantId)));
    if (!agentRow) {
      throw new Error(`Agent ${agentId} not found for tenant ${tenantId}`);
    }

    let address: string;
    let secret: string;
    if (chainFamily === "evm") {
      const pk = generatePrivateKey();
      const account = privateKeyToAccount(pk);
      address = account.address;
      secret = pk;
    } else {
      const kp = generateSolanaKeypair();
      address = kp.publicKey;
      secret = kp.secretKey;
    }

    // Bind the full keystore context (incl. venue) into the AEAD AAD, exactly as
    // createWallet does. Every decrypt path (signTransaction, signTypedData,
    // master-password rotation) supplies { tenantId, agentId, chainFamily, venue }
    // and the no-AAD fallback is disabled in production — so encrypting WITHOUT
    // the context made venue keys permanently undecryptable (silent custody loss).
    const encrypted = await this.keyStore.encrypt(secret, {
      tenantId,
      agentId,
      chainFamily,
      venue,
    });
    const createdAt = new Date();
    const policyRows = [
      {
        id: randomUUID(),
        agentId,
        type: "leverage-cap" as const,
        enabled: true,
        config: { maxLeverage: 5 },
      },
      {
        id: randomUUID(),
        agentId,
        type: "venue-allowlist" as const,
        enabled: true,
        config: { allowedVenues: [venue] },
      },
      {
        id: randomUUID(),
        agentId,
        type: "spending-limit" as const,
        enabled: true,
        config: { maxPerTxUsd: 2000, maxPerDayUsd: 2000, maxPerWeekUsd: 5000 },
      },
      {
        id: randomUUID(),
        agentId,
        type: "approved-addresses" as const,
        enabled: true,
        config: { addresses: approvedAddresses, mode: "whitelist" },
      },
    ];

    await db.transaction(async (tx) => {
      await tx.insert(encryptedChainKeys).values({
        agentId,
        chainFamily,
        venue,
        purpose: "venue",
        ciphertext: encrypted.ciphertext,
        iv: encrypted.iv,
        tag: encrypted.tag,
        salt: encrypted.salt,
      });

      await tx.insert(agentWallets).values({
        agentId,
        chainFamily,
        venue,
        purpose: "venue",
        address,
        createdAt,
      });

      await tx.insert(policies).values(policyRows);
    });

    return { address };
  }

  /**
   * Provision a fresh, venue-scoped wallet for an agent.
   *
   * Generates a new keypair (EVM via viem's `generatePrivateKey`, Solana
   * via Ed25519 in @solana/web3.js), encrypts the secret under the
   * vault's master KDF (AES-256-GCM + scrypt), and writes one row to
   * `agent_wallets` plus one to `encrypted_chain_keys`.
   *
   * Venue uniqueness is enforced by the DB index on
   * (agent_id, chain_family, COALESCE(venue, '')). A duplicate venue
   * request rejects at the DB layer.
   *
   * Returns the new public address. The private key is NEVER returned
   * and NEVER logged.
   */
  async createWallet(args: {
    agentId: string;
    /**
     * SEC-162: required caller-asserted tenant, verified against the agent's
     * real tenant before any wallet row is written. The AAD on the encrypted
     * key material was always bound to `agentRow.tenantId` (so cross-tenant
     * key theft was never possible); this check closes the residual DoS —
     * a caller reaching this method with another tenant's agentId can no
     * longer squat venue wallet slots for that agent. Routes that know the
     * tenant must pass it. Keeping this optional would preserve the original
     * in-process cross-tenant venue-slot-squatting path.
     */
    tenantId: string;
    venue?: string;
    scope?: string;
    chainType: WalletChainFamily;
    purpose?: string;
    bitcoin?: BitcoinCreateOptions;
    monero?: MoneroCreateOptions;
  }): Promise<WalletRowResult> {
    const { agentId, chainType, purpose } = args;
    if (
      chainType !== "evm" &&
      chainType !== "solana" &&
      chainType !== "bitcoin" &&
      chainType !== "monero"
    ) {
      throw new Error(`createWallet: unsupported chainType ${chainType}`);
    }

    const db = getDb();

    // Verify the agent exists. Surfacing a clear error here beats a
    // foreign-key violation from Postgres.
    const [agentRow] = await db
      .select({ id: agents.id, tenantId: agents.tenantId })
      .from(agents)
      .where(eq(agents.id, agentId));
    if (!agentRow) {
      throw new Error(`Agent ${agentId} not found`);
    }
    // Defense-in-depth tenant binding (SEC-162). Same "not found" phrasing as
    // the other tenant-scoped lookups so a mismatch does not confirm the
    // agent's existence under another tenant.
    if (agentRow.tenantId !== args.tenantId) {
      throw new Error(`Agent ${agentId} not found for tenant ${args.tenantId}`);
    }

    let address: string;
    let secret: string;
    let metadata: Record<string, unknown> = {};
    let venue = args.scope ?? args.venue;
    if (chainType === "evm") {
      if (!venue) throw new Error("createWallet requires a venue or scope");
      const pk = generatePrivateKey();
      const account = privateKeyToAccount(pk);
      address = account.address;
      secret = pk;
    } else if (chainType === "solana") {
      if (!venue) throw new Error("createWallet requires a venue or scope");
      const kp = generateSolanaKeypair();
      address = kp.publicKey;
      secret = kp.secretKey;
    } else if (chainType === "monero") {
      // Requires the wallet-rpc backend: the receiving address is only handed
      // out after wallet2 independently re-derives it from the same keys
      // (dual-derivation check). No backend → fail closed, never an
      // unvalidated address.
      const backend = this.getMoneroBackend();
      const network = args.monero?.network ?? backend.network;
      const account = args.monero?.account ?? 0;
      if (network !== backend.network) {
        throw new Error(
          `createWallet: the configured Monero sidecar operates on ${backend.network}, not ${network}`,
        );
      }
      if (account !== 0) {
        throw new Error("createWallet: only Monero account 0 is supported");
      }
      venue ??= moneroWalletScope(network, account);
      // A caller-supplied scope must agree with the wallet actually being
      // created — a mismatched scope would route future policy/network
      // checks against the wrong network.
      const parsedScope = parseMoneroWalletScope(venue);
      if (parsedScope.network !== network || parsedScope.account !== account) {
        throw new Error(
          `createWallet: scope ${venue} does not match the requested Monero network/account (${network}/${account})`,
        );
      }
      // restoreHeight = current chain height: a fresh wallet has no history,
      // so scanning starts at the tip and stays incremental (light client).
      const restoreHeight = await backend.getDaemonHeight();
      const generated = generateMoneroWallet(network);
      const payload: MoneroKeyPayloadV1 = {
        v: 1,
        network,
        spendKey: generated.spendKey,
        viewKey: generated.viewKey,
        address: generated.address,
        restoreHeight,
        account,
      };
      await backend.verifyWalletKeys(payload, {
        cacheId: this.moneroCacheId(agentRow.tenantId, agentId, venue),
      });
      address = generated.address;
      secret = serializeMoneroKeyPayload(payload);
      metadata = {
        monero: moneroPublicMetadataFromPayload(payload, `monero:${network}`),
      };
    } else {
      const bitcoinOptions: Required<BitcoinCreateOptions> = {
        network: args.bitcoin?.network ?? "mainnet",
        addressType: args.bitcoin?.addressType ?? "p2wpkh",
        account: args.bitcoin?.account ?? 0,
        change: args.bitcoin?.change ?? 0,
        index: args.bitcoin?.index ?? 0,
      };
      venue ??= bitcoinWalletScope(bitcoinOptions);
      const derived = await deriveBitcoinKey(
        generateMnemonic(256),
        bitcoinOptions,
      );
      address = derived.address;
      secret = derived.privateKey;
      metadata = {
        bitcoin: {
          network: derived.network,
          addressType: derived.addressType,
          path: derived.path,
          publicKey: derived.publicKey,
          xOnlyPublicKey: derived.xOnlyPublicKey,
          account: bitcoinOptions.account,
          change: bitcoinOptions.change,
          index: bitcoinOptions.index,
          caip2: bitcoinCaip2(derived.network),
        },
      };
    }
    if (!venue) {
      throw new Error("createWallet could not resolve a wallet scope");
    }

    const encrypted = await this.keyStore.encrypt(secret, {
      tenantId: agentRow.tenantId,
      agentId,
      chainFamily: chainType,
      venue,
    });
    const createdAt = new Date();

    await db.transaction(async (tx) => {
      await tx.insert(encryptedChainKeys).values({
        agentId,
        chainFamily: chainType,
        venue,
        purpose: purpose ?? null,
        ciphertext: encrypted.ciphertext,
        iv: encrypted.iv,
        tag: encrypted.tag,
        salt: encrypted.salt,
      });

      await tx.insert(agentWallets).values({
        agentId,
        chainFamily: chainType,
        venue,
        purpose: purpose ?? null,
        address,
        metadata,
        createdAt,
      });
    });

    return {
      agentId,
      chainFamily: chainType,
      venue,
      purpose: purpose ?? null,
      address,
      metadata,
    };
  }

  /**
   * List every wallet an agent owns, across venues and chain families.
   * Used by the agent dashboard and by Worker A's trade-sessions package
   * to enumerate available trading surfaces.
   *
   * Legacy NULL-venue rows are included. Order: legacy first, then
   * venue-scoped, by creation time ascending.
   */
  async listWallets(args: { agentId: string }): Promise<
    Array<{
      agentId: string;
      chainFamily: WalletChainFamily;
      venue: string | null;
      purpose: string | null;
      address: string;
      metadata: Record<string, unknown>;
      createdAt: Date;
    }>
  > {
    const { agentId } = args;
    const db = getDb();

    const rows = await db
      .select()
      .from(agentWallets)
      .where(eq(agentWallets.agentId, agentId))
      .orderBy(sql`${agentWallets.venue} NULLS FIRST`, agentWallets.createdAt);

    return rows.map((row) => ({
      agentId: row.agentId,
      chainFamily: row.chainFamily as WalletChainFamily,
      venue: row.venue,
      purpose: row.purpose,
      address: row.address,
      metadata: row.metadata,
      createdAt: row.createdAt,
    }));
  }
}

/**
 * Map an EVM chainId (or 101/102 for Solana) to its chain family.
 * Exposed at module scope so non-method callers (tests) can use it.
 */
function chainIdToChainFamily(chainId: number): WalletChainFamily {
  if (chainId === 101 || chainId === 102) return "solana";
  if (chainId === 201 || chainId === 202) return "bitcoin";
  if (chainId === 301 || chainId === 302) return "monero";
  return "evm";
}
