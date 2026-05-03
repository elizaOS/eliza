import {
  agents,
  agentWallets,
  encryptedChainKeys,
  encryptedKeys,
  getDb,
  toAgentIdentity,
  transactions,
} from "@stwd/db";
import type {
  AgentIdentity,
  PolicyResult,
  RpcRequest,
  RpcResponse,
  SignRequest,
  SignSolanaTransactionRequest,
  SignTypedDataRequest,
  TxStatus,
} from "@stwd/shared";
import { toCaip2 } from "@stwd/shared";
import { and, eq, inArray } from "drizzle-orm";
import {
  type Chain,
  createPublicClient,
  createWalletClient,
  formatEther,
  http,
  type TransactionSerializable,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { arbitrum, base, baseSepolia, bsc, bscTestnet, mainnet, polygon } from "viem/chains";

import { type EncryptedKey, KeyStore } from "./keystore";
import {
  generateSolanaKeypair,
  getSolanaBalance,
  restoreSolanaKeypair,
  signSolanaMessage,
  signSolanaTransaction,
} from "./solana";
import { getTokenBalances as fetchTokenBalances, type TokenBalance } from "./tokens";

export interface VaultConfig {
  masterPassword: string;
  rpcUrl?: string;
  chainId?: number;
}

const CHAINS: Record<number, Chain> = {
  1: mainnet, // Ethereum
  56: bsc, // BSC
  97: bscTestnet, // BSC Testnet
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
 * Detect chain type from wallet address format.
 * EVM addresses start with "0x"; Solana addresses are base58 (no "0x" prefix).
 */
function detectChainType(walletAddress: string): "evm" | "solana" {
  return walletAddress.startsWith("0x") ? "evm" : "solana";
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
}

/**
 * Vault — the core signing service.
 *
 * Manages agent wallets: generates keypairs, stores encrypted private keys,
 * and signs transactions. The private key is decrypted only for the duration
 * of a signing operation and never exposed to agent containers.
 */
export class Vault {
  private keyStore: KeyStore;
  private config: VaultConfig;

  constructor(config: VaultConfig) {
    this.config = config;
    this.keyStore = new KeyStore(config.masterPassword);
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
    const evmEncrypted = this.keyStore.encrypt(evmPrivateKey);
    const solEncrypted = this.keyStore.encrypt(solKp.secretKey);

    const createdAt = new Date();

    // ── Persist all rows atomically — roll back everything on any failure ─
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
        { agentId, chainFamily: "evm", address: evmAddress, createdAt },
        { agentId, chainFamily: "solana", address: solanaAddress, createdAt },
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
   * Get an agent's public identity, including `walletAddresses` for agents
   * created with multi-wallet support.
   */
  async getAgent(tenantId: string, agentId: string): Promise<AgentIdentity | undefined> {
    const db = getDb();
    const [agent] = await db
      .select()
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.tenantId, tenantId)));

    if (!agent) return undefined;

    const identity = toAgentIdentity(agent) as AgentIdentity;
    const wallets = await db.select().from(agentWallets).where(eq(agentWallets.agentId, agentId));

    if (wallets.length > 0) {
      const addresses: { evm?: string; solana?: string } = {};
      for (const w of wallets) {
        if (w.chainFamily === "evm") addresses.evm = w.address;
        if (w.chainFamily === "solana") addresses.solana = w.address;
      }
      identity.walletAddresses = addresses;
    }

    return identity;
  }

  /**
   * List all agent identities for a tenant, including `walletAddresses`
   * for agents created with multi-wallet support.
   */
  async listAgents(tenantId: string): Promise<AgentIdentity[]> {
    const db = getDb();
    const rows = await db.select().from(agents).where(eq(agents.tenantId, tenantId));
    if (rows.length === 0) return [];

    const agentIds = rows.map((r) => r.id);
    const walletRows = await db
      .select()
      .from(agentWallets)
      .where(inArray(agentWallets.agentId, agentIds));

    // Build a map: agentId → { evm?, solana? }
    const walletMap = new Map<string, { evm?: string; solana?: string }>();
    for (const w of walletRows) {
      if (!walletMap.has(w.agentId)) walletMap.set(w.agentId, {});
      const entry = walletMap.get(w.agentId)!;
      if (w.chainFamily === "evm") entry.evm = w.address;
      if (w.chainFamily === "solana") entry.solana = w.address;
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
  async listAgentsByTenant(tenantId: string): Promise<AgentIdentity[]> {
    return this.listAgents(tenantId);
  }

  /**
   * Get all wallet addresses for an agent across all chain families.
   * Returns a map of chainFamily → address.
   */
  async getAddresses(
    tenantId: string,
    agentId: string,
  ): Promise<Array<{ chainFamily: "evm" | "solana"; address: string }>> {
    const db = getDb();
    // Verify agent belongs to this tenant
    const [agent] = await db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.tenantId, tenantId)));
    if (!agent) {
      throw new Error(`Agent ${agentId} not found for tenant ${tenantId}`);
    }

    const wallets = await db.select().from(agentWallets).where(eq(agentWallets.agentId, agentId));

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
      chainFamily: w.chainFamily as "evm" | "solana",
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
      .where(and(eq(agents.id, request.agentId), eq(agents.tenantId, request.tenantId)));

    if (!agentRow) {
      throw new Error(`Agent ${request.agentId} not found for tenant ${request.tenantId}`);
    }

    const chainId = request.chainId || this.config.chainId || 8453;
    // Determine chain family from chainId (101/102 = Solana)
    const isSolana = chainId === 101 || chainId === 102;
    const chainFamilyToUse = isSolana ? "solana" : "evm";
    const shouldBroadcast = request.broadcast !== false;

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
        ),
      );

    if (chainKey) {
      secretKey = this.keyStore.decrypt({
        ciphertext: chainKey.ciphertext,
        iv: chainKey.iv,
        tag: chainKey.tag,
        salt: chainKey.salt,
      });
    } else {
      // Fallback: legacy encrypted_keys table (EVM only)
      const [legacyKey] = await db
        .select()
        .from(encryptedKeys)
        .where(eq(encryptedKeys.agentId, request.agentId));
      if (!legacyKey) {
        throw new Error(
          `No signing key found for agent ${request.agentId} on chain family ${chainFamilyToUse}`,
        );
      }
      secretKey = this.keyStore.decrypt(legacyKey as EncryptedKey);
    }

    // Also resolve the wallet address for this chain (for Solana tx signing)
    let _walletAddress: string = agentRow.walletAddress; // default EVM
    if (isSolana) {
      const [solWallet] = await db
        .select({ address: agentWallets.address })
        .from(agentWallets)
        .where(
          and(eq(agentWallets.agentId, request.agentId), eq(agentWallets.chainFamily, "solana")),
        );
      if (solWallet) _walletAddress = solWallet.address;
      else
        _walletAddress =
          detectChainType(agentRow.walletAddress) === "solana" ? agentRow.walletAddress : ""; // no solana wallet
    }

    let hash: string;

    if (isSolana) {
      const rpcUrl = this.config.rpcUrl ?? resolveSolanaRpc(chainId);
      hash = await signSolanaTransaction(secretKey, request.to, BigInt(request.value), rpcUrl);
    } else {
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

        hash = await client.sendTransaction({
          to: request.to as `0x${string}`,
          value: BigInt(request.value),
          data: request.data as `0x${string}` | undefined,
          gas: request.gasLimit ? BigInt(request.gasLimit) : undefined,
        });
      } else {
        // Sign without broadcasting — return the serialized signed transaction
        const rpcUrl = CHAIN_RPCS[chainId] ?? this.config.rpcUrl;
        const publicClient = createPublicClient({
          chain,
          transport: http(rpcUrl),
        });
        const nonce =
          request.nonce ??
          (await publicClient.getTransactionCount({
            address: account.address,
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

    const txId = options.txId ?? crypto.randomUUID();
    const signedAt = new Date();

    await db
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
        policyResults: options.policyResults ?? [],
        signedAt,
        createdAt: signedAt,
      })
      .onConflictDoUpdate({
        target: transactions.id,
        set: {
          agentId: request.agentId,
          status: shouldBroadcast ? (options.status ?? "signed") : "signed",
          toAddress: request.to,
          value: request.value,
          data: request.data,
          chainId,
          txHash: shouldBroadcast ? hash : undefined,
          policyResults: options.policyResults ?? [],
          signedAt,
        },
      });

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
      (detectChainType(agent.walletAddress) === "solana" ? agent.walletAddress : undefined);
    const isSolana =
      requestedSolana ||
      (!chainId && Boolean(solanaAddress) && detectChainType(agent.walletAddress) === "solana");

    if (isSolana && solanaAddress) {
      const resolvedChainId = chainId ?? 101;
      const rpcUrl = this.config.rpcUrl ?? resolveSolanaRpc(resolvedChainId);
      const { lamports, formatted } = await getSolanaBalance(solanaAddress, rpcUrl);
      return {
        native: lamports,
        nativeFormatted: formatted,
        chainId: resolvedChainId,
        symbol: "SOL",
        walletAddress: solanaAddress,
      };
    }

    const resolvedChainId = chainId && !requestedSolana ? chainId : (this.config.chainId ?? 8453);
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

    if (chainType === "solana") {
      // For Solana, the private key should be a 64-byte hex string (seed + pubkey)
      // or a 32-byte hex seed — we'll handle both
      const kp = restoreSolanaKeypair(privateKey);
      walletAddress = kp.publicKey.toBase58();
    } else {
      // EVM — expect 0x-prefixed hex private key
      const normalizedKey = privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`;
      const account = privateKeyToAccount(normalizedKey as `0x${string}`);
      walletAddress = account.address;
    }

    const encryptedKey = this.keyStore.encrypt(privateKey);
    const now = new Date();

    // Check if agent already exists
    const [existingAgent] = await db
      .select()
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.tenantId, tenantId)));

    // Wrap all writes atomically — roll back on any failure
    await db.transaction(async (tx) => {
      if (existingAgent) {
        // Update wallet address and replace encrypted key
        await tx
          .update(agents)
          .set({ walletAddress, updatedAt: now })
          .where(and(eq(agents.id, agentId), eq(agents.tenantId, tenantId)));

        await tx.delete(encryptedKeys).where(eq(encryptedKeys.agentId, agentId));

        await tx.insert(encryptedKeys).values({
          agentId,
          ciphertext: encryptedKey.ciphertext,
          iv: encryptedKey.iv,
          tag: encryptedKey.tag,
          salt: encryptedKey.salt,
        });
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

        await tx.insert(encryptedKeys).values({
          agentId,
          ciphertext: encryptedKey.ciphertext,
          iv: encryptedKey.iv,
          tag: encryptedKey.tag,
          salt: encryptedKey.salt,
        });
      }

      // ── Also write to multi-wallet tables so new signing paths find the key ─
      // Upsert into encrypted_chain_keys (replace if key already imported)
      await tx
        .insert(encryptedChainKeys)
        .values({
          agentId,
          chainFamily: chainType,
          ciphertext: encryptedKey.ciphertext,
          iv: encryptedKey.iv,
          tag: encryptedKey.tag,
          salt: encryptedKey.salt,
        })
        .onConflictDoUpdate({
          target: [encryptedChainKeys.agentId, encryptedChainKeys.chainFamily],
          set: {
            ciphertext: encryptedKey.ciphertext,
            iv: encryptedKey.iv,
            tag: encryptedKey.tag,
            salt: encryptedKey.salt,
          },
        });

      // Upsert into agent_wallets
      await tx
        .insert(agentWallets)
        .values({
          agentId,
          chainFamily: chainType,
          address: walletAddress,
          createdAt: now,
        })
        .onConflictDoUpdate({
          target: [agentWallets.agentId, agentWallets.chainFamily],
          set: { address: walletAddress },
        });
    });

    return { walletAddress };
  }

  /**
   * Sign an arbitrary message. Routes to Solana Ed25519 or EVM ECDSA
   * based on the agent's wallet address format.
   */
  async signMessage(tenantId: string, agentId: string, message: string): Promise<string> {
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

    // Resolve signing key: prefer encryptedChainKeys (multi-wallet), fall back to legacy encryptedKeys
    let secretKey: string;
    const [chainKey] = await db
      .select()
      .from(encryptedChainKeys)
      .where(
        and(
          eq(encryptedChainKeys.agentId, agentId),
          eq(encryptedChainKeys.chainFamily, chainFamilyToUse),
        ),
      );

    if (chainKey) {
      secretKey = this.keyStore.decrypt({
        ciphertext: chainKey.ciphertext,
        iv: chainKey.iv,
        tag: chainKey.tag,
        salt: chainKey.salt,
      });
    } else {
      // Fallback: legacy encrypted_keys table
      const [legacyKey] = await db
        .select()
        .from(encryptedKeys)
        .where(eq(encryptedKeys.agentId, agentId));
      if (!legacyKey) {
        throw new Error(`No signing key found for agent ${agentId}`);
      }
      secretKey = this.keyStore.decrypt(legacyKey as EncryptedKey);
    }

    if (isSolana) {
      return signSolanaMessage(secretKey, message);
    }

    const account = privateKeyToAccount(secretKey as `0x${string}`);
    const signature = await account.signMessage({ message });
    return signature;
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
      .where(and(eq(agents.id, request.agentId), eq(agents.tenantId, request.tenantId)));

    if (!agentRow) {
      throw new Error(`Agent ${request.agentId} not found for tenant ${request.tenantId}`);
    }

    if (detectChainType(agentRow.walletAddress) === "solana") {
      throw new Error("EIP-712 typed data signing is not supported for Solana wallets");
    }

    // Resolve signing key: prefer encryptedChainKeys (multi-wallet), fall back to legacy encryptedKeys
    let secretKey: string;
    const [chainKey] = await db
      .select()
      .from(encryptedChainKeys)
      .where(
        and(
          eq(encryptedChainKeys.agentId, request.agentId),
          eq(encryptedChainKeys.chainFamily, "evm"),
        ),
      );

    if (chainKey) {
      secretKey = this.keyStore.decrypt({
        ciphertext: chainKey.ciphertext,
        iv: chainKey.iv,
        tag: chainKey.tag,
        salt: chainKey.salt,
      });
    } else {
      // Fallback: legacy encrypted_keys table
      const [legacyKey] = await db
        .select()
        .from(encryptedKeys)
        .where(eq(encryptedKeys.agentId, request.agentId));
      if (!legacyKey) {
        throw new Error(`No signing key found for agent ${request.agentId}`);
      }
      secretKey = this.keyStore.decrypt(legacyKey as EncryptedKey);
    }

    const account = privateKeyToAccount(secretKey as `0x${string}`);

    const signature = await account.signTypedData({
      domain: {
        name: request.domain.name,
        version: request.domain.version,
        chainId: request.domain.chainId,
        verifyingContract: request.domain.verifyingContract as `0x${string}` | undefined,
        salt: request.domain.salt as `0x${string}` | undefined,
      },
      types: request.types as Record<string, Array<{ name: string; type: string }>>,
      primaryType: request.primaryType,
      message: request.value,
    });

    return signature;
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
      .where(and(eq(agents.id, request.agentId), eq(agents.tenantId, request.tenantId)));

    if (!agentRow) {
      throw new Error(`Agent ${request.agentId} not found for tenant ${request.tenantId}`);
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
        ),
      );

    if (chainKey) {
      secretKey = this.keyStore.decrypt({
        ciphertext: chainKey.ciphertext,
        iv: chainKey.iv,
        tag: chainKey.tag,
        salt: chainKey.salt,
      });
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
        throw new Error(`No Solana signing key found for agent ${request.agentId}`);
      }
      secretKey = this.keyStore.decrypt(legacyKey as EncryptedKey);
    }

    const keypair = restoreSolanaKeypair(secretKey);
    const chainId = request.chainId ?? 101;
    const rpcUrl = this.config.rpcUrl ?? resolveSolanaRpc(chainId);
    const shouldBroadcast = request.broadcast !== false;

    // Deserialize the transaction from base64
    const { Transaction: SolTransaction, Connection } = await import("@solana/web3.js");
    const txBytes = Uint8Array.from(atob(request.transaction), (c) => c.charCodeAt(0));
    const tx = SolTransaction.from(txBytes);

    // Sign the transaction
    tx.partialSign(keypair);

    if (shouldBroadcast) {
      const connection = new Connection(rpcUrl, "confirmed");
      const rawTx = tx.serialize();
      const sig = await connection.sendRawTransaction(rawTx, {
        skipPreflight: false,
        preflightCommitment: "confirmed",
      });

      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
      await connection.confirmTransaction(
        { signature: sig, blockhash, lastValidBlockHeight },
        "confirmed",
      );

      return {
        signature: sig,
        broadcast: true,
        chainId,
        caip2: toCaip2(chainId),
      };
    }

    // Return serialized signed transaction as base64
    const rawBytes = tx.serialize();
    const serialized = btoa(Array.from(rawBytes, (b) => String.fromCharCode(b)).join(""));
    return {
      signature: serialized,
      broadcast: false,
      chainId,
      caip2: toCaip2(chainId),
    };
  }

  /**
   * Export the decrypted private keys for an agent.
   * Returns both EVM and Solana keys where available.
   * The caller is responsible for securing the returned material.
   */
  async exportPrivateKey(
    tenantId: string,
    agentId: string,
  ): Promise<{
    evm?: { privateKey: string; address: string };
    solana?: { privateKey: string; address: string };
  }> {
    const db = getDb();

    // Verify agent belongs to this tenant
    const [agentRow] = await db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.tenantId, tenantId)));

    if (!agentRow) {
      throw new Error(`Agent ${agentId} not found for tenant ${tenantId}`);
    }

    const result: {
      evm?: { privateKey: string; address: string };
      solana?: { privateKey: string; address: string };
    } = {};

    // ── Get EVM key (prefer multi-chain table, fall back to legacy) ──────
    const [evmChainKey] = await db
      .select()
      .from(encryptedChainKeys)
      .where(
        and(eq(encryptedChainKeys.agentId, agentId), eq(encryptedChainKeys.chainFamily, "evm")),
      );

    if (evmChainKey) {
      const pk = this.keyStore.decrypt({
        ciphertext: evmChainKey.ciphertext,
        iv: evmChainKey.iv,
        tag: evmChainKey.tag,
        salt: evmChainKey.salt,
      });
      const [evmWallet] = await db
        .select({ address: agentWallets.address })
        .from(agentWallets)
        .where(and(eq(agentWallets.agentId, agentId), eq(agentWallets.chainFamily, "evm")));
      result.evm = {
        privateKey: pk,
        address: evmWallet?.address ?? privateKeyToAccount(pk as `0x${string}`).address,
      };
    } else {
      // Legacy: encrypted_keys table (EVM only)
      const [legacyKey] = await db
        .select()
        .from(encryptedKeys)
        .where(eq(encryptedKeys.agentId, agentId));
      if (legacyKey) {
        const pk = this.keyStore.decrypt(legacyKey as EncryptedKey);
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
        and(eq(encryptedChainKeys.agentId, agentId), eq(encryptedChainKeys.chainFamily, "solana")),
      );

    if (solChainKey) {
      const pk = this.keyStore.decrypt({
        ciphertext: solChainKey.ciphertext,
        iv: solChainKey.iv,
        tag: solChainKey.tag,
        salt: solChainKey.salt,
      });
      const [solWallet] = await db
        .select({ address: agentWallets.address })
        .from(agentWallets)
        .where(and(eq(agentWallets.agentId, agentId), eq(agentWallets.chainFamily, "solana")));
      result.solana = { privateKey: pk, address: solWallet?.address ?? "" };
    }

    return result;
  }

  /**
   * Proxy a read-only RPC call to the appropriate chain provider.
   * Supports both EVM and Solana RPC methods.
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

    // Block signing/state-modifying methods — this is read-only passthrough
    const blockedMethods = [
      "eth_sendTransaction",
      "eth_sendRawTransaction",
      "eth_sign",
      "personal_sign",
      "eth_signTypedData",
      "eth_signTypedData_v4",
      "sendTransaction",
    ];
    if (blockedMethods.includes(request.method)) {
      throw new Error(
        `Method ${request.method} is not allowed via RPC passthrough — use the signing endpoints`,
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
    });

    if (!response.ok) {
      throw new Error(`RPC request failed: ${response.status} ${response.statusText}`);
    }

    return (await response.json()) as RpcResponse;
  }
}
