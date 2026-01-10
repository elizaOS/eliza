import {
  type IAgentRuntime,
  logger,
  Service,
  ServiceType,
  type ServiceTypeName,
} from "@elizaos/core";
import {
  IWalletService,
  type WalletPortfolio as siWalletPortfolio,
} from "@elizaos/service-interfaces";
import {
  AccountLayout,
  ExtensionType,
  getAssociatedTokenAddressSync,
  getExtensionData,
  getMint,
  MintLayout,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  unpackAccount,
  unpackMint,
} from "@solana/spl-token";
// parses the raw Token-2022 metadata struct
import { unpack as unpackToken2022Metadata } from "@solana/spl-token-metadata";
import {
  type AccountInfo,
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  type ParsedAccountData,
  PublicKey,
  SendTransactionError,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import BigNumber from "bignumber.js";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { SOLANA_SERVICE_NAME, SOLANA_WALLET_DATA_CACHE_KEY } from "./constants";
import { getWalletKey } from "./keypairUtils";
import type { Item, Prices, WalletPortfolio } from "./types";

const PROVIDER_CONFIG = {
  BIRDEYE_API: "https://public-api.birdeye.so",
  MAX_RETRIES: 3,
  RETRY_DELAY: 2000,
  DEFAULT_RPC: "https://api.mainnet-beta.solana.com",
  TOKEN_ADDRESSES: {
    SOL: "So11111111111111111111111111111111111111112",
    BTC: "3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh",
    ETH: "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs",
  },
};

export type MintBalance = {
  amount: string;
  decimals: number;
  uiAmount: number;
};

type KeyedParsedTokenAccount = {
  pubkey: PublicKey;
  account: AccountInfo<ParsedAccountData>;
};

type ParsedTokenAccountsResponse = Awaited<
  ReturnType<Connection["getParsedTokenAccountsByOwner"]>
>;
/*
type ParsedTokenAccountsResponse = Promise<RpcResponseAndContext<
    Array<{
      pubkey: PublicKey;
      account: AccountInfo<ParsedAccountData>;
    }>
  >>
*/

const METADATA_PROGRAM_ID = new PublicKey(
  "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s", // Metaplex Token Metadata Program ID
);

// CA: { }

export interface ISolanaPluginServiceAPI extends Service {
  executeSwap: (
    wallets: Array<{ keypair: any; amount: number }>,
    signal: any,
  ) => Promise<Record<string, unknown>>;
  /*
  executeSwap: (params: {
    inputMint: string;
    outputMint: string;
    amount: string; // Amount in base units of input token
    slippageBps: number;
    payerAddress: string; // Public key of the payer (must match service's configured wallet)
    priorityFeeMicroLamports?: number;
  }) => Promise<{
    success: boolean;
    signature?: string;
    error?: string;
    outAmount?: string;
    inAmount?: string;
    swapUsdValue?: string;
  }>;
  */
  //getSolBalance: (publicKey: string) => Promise<number>; // Returns SOL balance (not lamports)
  /*
  getTokenBalance: (
    publicKey: string,
    mintAddress: string
  ) => Promise<{ amount: string; decimals: number; uiAmount: number } | null>;
  */
  getPublicKey: () => PublicKey | null; // Returns base58 public key
}

// split out off to keep this wrapper simple, so we can move it out of here
// it's a single unit focused on one thing (reduce scope of main service)
export class SolanaWalletService extends IWalletService {
  private _solanaService: SolanaService | null = null;

  constructor(runtime?: IAgentRuntime) {
    if (!runtime) throw new Error("runtime is required for solana service");
    super(runtime);
  }

  private get solanaService(): SolanaService {
    if (!this._solanaService) {
      this._solanaService = this.runtime.getService(
        "chain_solana",
      ) as SolanaService;
      if (!this._solanaService) {
        throw new Error("Solana Service is required for Solana Wallet Service");
      }
    }
    return this._solanaService;
  }

  /**
   * Retrieves the entire portfolio of assets held by the wallet.
   * @param owner - Optional: The specific wallet address/owner to query.
   * @returns A promise that resolves to the wallet's portfolio.
   */
  public async getPortfolio(owner?: string): Promise<siWalletPortfolio> {
    const publicKey = await this.solanaService.getPublicKey();
    const publicKeyBase58 = publicKey && publicKey.toBase58();
    if (owner && publicKeyBase58 && owner !== publicKeyBase58) {
      throw new Error(
        `This SolanaService instance can only get the portfolio for its configured wallet: ${publicKeyBase58}`,
      );
    }
    const wp: WalletPortfolio = await this.solanaService.updateWalletData(true);
    const out: siWalletPortfolio = {
      totalValueUsd: parseFloat(wp.totalUsd),
      assets: wp.items.map((i) => ({
        address: i.address,
        symbol: i.symbol,
        balance: Number(i.uiAmount ?? 0).toString(),
        decimals: i.decimals,
        valueUsd: Number(i.valueUsd ?? 0),
      })),
    };
    return out;
  }

  /**
   * Retrieves the balance of a specific asset in the wallet.
   * @param assetAddress - The mint address or native identifier ('SOL') of the asset.
   * @param owner - Optional: The specific wallet address/owner to query.
   * @returns A promise that resolves to the user-friendly (decimal-adjusted) balance of the asset held.
   */
  public async getBalance(
    assetAddress: string,
    owner?: string,
  ): Promise<number> {
    const publicKey = await this.solanaService.getPublicKey();
    const publicKeyBase58 = publicKey ? publicKey.toBase58() : null;
    const ownerAddress: string | null = owner ?? publicKeyBase58;
    if (!ownerAddress) {
      return -1;
    }
    if (
      assetAddress.toUpperCase() === "SOL" ||
      assetAddress === PROVIDER_CONFIG.TOKEN_ADDRESSES.SOL
    ) {
      //return this.getSolBalance(ownerAddress);
      const balances = await this.solanaService.getBalancesByAddrs([
        ownerAddress,
      ]);
      const balance = balances[ownerAddress] ?? 0;
      return balance;
    }
    //const tokenBalance = await this.getTokenBalance(ownerAddress, assetAddress);
    //return tokenBalance?.uiAmount || 0;
    const tokensBalances: Record<string, KeyedParsedTokenAccount[]> =
      await this.solanaService.getTokenAccountsByKeypairs([ownerAddress]);
    const heldTokens = tokensBalances[ownerAddress] || [];
    for (const t of heldTokens) {
      //const decimals = t.account.data.parsed.info.tokenAmount.decimals;
      //const balance = Number(amountRaw) / (10 ** decimals);
      //const ca = new PublicKey(t.account.data.parsed.info.mint);
      if (t.account.data.parsed.info.mint === assetAddress) {
        return t.account.data.parsed.info.tokenAmount.uiAmount;
      }
    }
    this.runtime.logger.log("could not find", assetAddress, "in", heldTokens);
    return -1;
  }

  /**
   * Transfers SOL from a specified keypair to a public key.
   * The service's own wallet is used to pay transaction fees.
   * @param {Keypair} from - The keypair of the account to send SOL from.
   * @param {PublicKey} to - The public key of the account to send SOL to.
   * @param {number} lamports - The amount of SOL to send, in lamports.
   * @returns {Promise<string>} The transaction signature.
   * @throws {Error} If the transfer fails.
   */
  public async transferSol(
    from: Keypair,
    to: PublicKey,
    lamports: number,
  ): Promise<string> {
    try {
      const payerKey = await this.solanaService.getPublicKey();
      if (!payerKey || payerKey === null) {
        throw new Error(
          "SolanaService is not initialized with a fee payer key, cannot send transaction.",
        );
      }
      const connection = this.solanaService.getConnection();

      const transaction = new TransactionMessage({
        payerKey,
        recentBlockhash: (await connection.getLatestBlockhash()).blockhash,
        instructions: [
          SystemProgram.transfer({
            fromPubkey: from.publicKey,
            toPubkey: to,
            lamports: lamports,
          }),
        ],
      }).compileToV0Message();

      const versionedTransaction = new VersionedTransaction(transaction);

      const serviceKeypair = await this.solanaService.getWalletKeypair();
      versionedTransaction.sign([from, serviceKeypair]);

      const signature = await connection.sendTransaction(versionedTransaction, {
        skipPreflight: false,
      });

      const confirmation = await connection.confirmTransaction(
        signature,
        "confirmed",
      );
      if (confirmation.value.err) {
        throw new Error(
          `Transaction confirmation failed: ${JSON.stringify(confirmation.value.err)}`,
        );
      }

      return signature;
    } catch (error: unknown) {
      this.runtime.logger.error({ error }, "SolanaService: transferSol failed");
      throw error;
    }
  }

  /**
   * Starts the Solana wallet service with the given agent runtime.
   *
   * @param {IAgentRuntime} runtime - The agent runtime to use for the Solana service.
   * @returns {Promise<SolanaService>} The initialized Solana service.
   */
  static async start(runtime: IAgentRuntime): Promise<Service> {
    runtime.logger.log(
      `SolanaWalletService start for ${runtime.character.name}`,
    );

    const solanaWalletService = new SolanaWalletService(runtime);
    return solanaWalletService;
  }

  /**
   * Stops the Solana wallet service.
   *
   * @param {IAgentRuntime} runtime - The agent runtime.
   * @returns {Promise<void>} - A promise that resolves once the Solana service has stopped.
   */
  static async stop(runtime: IAgentRuntime): Promise<void> {
    const client = runtime.getService(
      ServiceType.WALLET,
    ) as SolanaService | null;
    if (!client) {
      logger.error("SolanaWalletService not found during static stop");
      return;
    }
    await client.stop();
  }

  /**
   * @returns {Promise<void>} A Promise that resolves when the update interval is stopped.
   */
  async stop(): Promise<void> {}
}

/**
 * Service class for interacting with the Solana blockchain and accessing wallet data.
 * @extends Service
 */
// implements ISolanaPluginServiceAPI
export class SolanaService extends Service {
  static override readonly serviceType: string = SOLANA_SERVICE_NAME;
  public readonly capabilityDescription =
    "The agent is able to interact with the Solana blockchain, and has access to the wallet data" as unknown as typeof IWalletService.prototype.capabilityDescription;

  private lastUpdate = 0;
  private readonly UPDATE_INTERVAL = 2 * 60_000; // 2 minutes
  private connection: Connection;

  // Lazy load fields (renamed from publicKey/keypair)
  private _publicKey: PublicKey | null = null;
  private _keypair: Keypair | null = null;

  // Promise cache for lazy loading (anti-thundering herd pattern)
  private _publicKeyPromise: Promise<PublicKey | null> | null = null;
  private _keypairPromise: Promise<Keypair | null> | null = null;

  // Load attempt counters (for debugging/logging)
  private _publicKeyLoadAttempts = 0;
  private _keypairLoadAttempts = 0;

  private exchangeRegistry: Record<number, unknown> = {};
  // probably should be an array of numbers?
  private subscriptions: Map<string, number> = new Map();

  jupiterService: any;

  // always multiple these
  static readonly LAMPORTS2SOL = 1 / LAMPORTS_PER_SOL;
  static readonly SOL2LAMPORTS = LAMPORTS_PER_SOL;

  // Token decimals cache
  private decimalsCache = new Map<string, number>([
    ["EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", 6], // USDC
    ["Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", 6], // USDT
    ["So11111111111111111111111111111111111111112", 9], // SOL
  ]);

  /**
   * Constructor for creating an instance of the class.
   * @param {IAgentRuntime} runtime - The runtime object that provides access to agent-specific functionality.
   */
  constructor(runtime?: IAgentRuntime) {
    if (!runtime) throw new Error("runtime is required for solana service");
    super(runtime);
    this.exchangeRegistry = {};
    const rpcUrl = runtime.getSetting("SOLANA_RPC_URL");
    const rpcUrlStr = typeof rpcUrl === "string" ? rpcUrl : PROVIDER_CONFIG.DEFAULT_RPC;
    this.connection = new Connection(rpcUrlStr);

    // jupiter support detection
    // shouldn't even be here...
    runtime
      .getServiceLoadPromise("JUPITER_SERVICE" as ServiceTypeName)
      .then(async () => {
        // now we have jupiter lets register our services
        this.jupiterService = runtime.getService(
          "JUPITER_SERVICE" as ServiceTypeName,
        ) as any;
      });
    this.subscriptions = new Map();
  }

  /**
   * Lazy load public key with promise caching (anti-thundering herd pattern)
   * Returns null if wallet key is not available yet (e.g., not created or not in settings)
   */
  private async ensurePublicKey(): Promise<PublicKey | null> {
    if (this._publicKey) return this._publicKey;
    if (this._publicKeyPromise) return this._publicKeyPromise;

    this._publicKeyLoadAttempts++;
    this._publicKeyPromise = (async () => {
      try {
        const result = await getWalletKey(this.runtime, false);
        if (!result.publicKey) return null;
        this._publicKey = result.publicKey;

        // Setup subscription
        await this.subscribeToAccount(this._publicKey.toBase58(), async () => {
          await this.updateWalletData();
        });

        await this.updateWalletData();
        return this._publicKey;
      } catch (error) {
        this.runtime.logger.error(
          "[Solana] Failed to load public key:",
          error instanceof Error ? error.message : String(error),
        );
        return null;
      } finally {
        this._publicKeyPromise = null;
      }
    })();

    return this._publicKeyPromise;
  }

  /**
   * Lazy load keypair with promise caching (anti-thundering herd pattern)
   * Returns null if wallet key is not available yet
   */
  private async ensureKeypair(): Promise<Keypair | null> {
    if (this._keypair) return this._keypair;
    if (this._keypairPromise) return this._keypairPromise;

    this._keypairLoadAttempts++;
    this._keypairPromise = (async () => {
      try {
        const result = await getWalletKey(this.runtime, true);
        if (!result.keypair) return null;
        this._keypair = result.keypair;
        return this._keypair;
      } catch (error) {
        this.runtime.logger.error(
          "[Solana] Failed to load keypair:",
          error instanceof Error ? error.message : String(error),
        );
        return null;
      } finally {
        this._keypairPromise = null;
      }
    })();

    return this._keypairPromise;
  }

  /**
   * Force reload wallet keys from settings (e.g., after wallet creation)
   * Clears cached values and reloads on next access
   */
  async reloadKeys(): Promise<void> {
    this._publicKey = null;
    this._keypair = null;
    this._publicKeyPromise = null;
    this._keypairPromise = null;
    this._publicKeyLoadAttempts = 0;
    this._keypairLoadAttempts = 0;

    // Preload public key to setup subscriptions
    await this.ensurePublicKey();
  }

  /**
   * Retrieves the connection object.
   *
   * @returns {Connection} The connection object.
   */
  public getConnection(): Connection {
    return this.connection;
  }

  /**
   * Registers a swap provider to execute swaps
   * @param {any} provider - The provider to register
   * @returns {Promise<number>} The ID assigned to the registered provider
   */
  async registerExchange(provider: any) {
    const id = Object.values(this.exchangeRegistry).length + 1;
    this.runtime.logger.success(
      `Registered ${provider.name} as Solana provider #${id}`,
    );
    this.exchangeRegistry[id] = provider;
    return id;
  }

  /**
   * Fetches data from the provided URL with retry logic.
   * @param {string} url - The URL to fetch data from.
   * @param {Record<string, any>} [options={}] - The options for the fetch request.
   * @returns {Promise<unknown>} - A promise that resolves to the fetched data.
   */
  private async birdeyeFetchWithRetry(
    url: string,
    options: Record<string, any> = {},
  ): Promise<unknown> {
    let lastError: Error | undefined;

    for (let i = 0; i < PROVIDER_CONFIG.MAX_RETRIES; i++) {
      try {
        const response = await (globalThis as any).fetch(url, {
          ...options,
          headers: {
            Accept: "application/json",
            "x-chain": "solana",
            "X-API-KEY": this.runtime.getSetting("BIRDEYE_API_KEY"),
            ...options.headers,
          },
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(
            `HTTP error! status: ${response.status}, message: ${errorText}`,
          );
        }

        return await response.json();
      } catch (error) {
        logger.error(`Attempt ${i + 1} failed: ${error}`);
        logger.error({ error }, `Attempt ${i + 1} failed`);
        lastError = error as Error;
        if (i < PROVIDER_CONFIG.MAX_RETRIES - 1) {
          await new Promise((resolve) =>
            setTimeout(resolve, PROVIDER_CONFIG.RETRY_DELAY * 2 ** i),
          );
        }
      }
    }

    // If we exhausted all retries, throw the last error or a generic one
    throw lastError ?? new Error(`Failed to fetch ${url} after ${PROVIDER_CONFIG.MAX_RETRIES} retries`);
  }

  async batchGetMultipleAccountsInfo(
    pubkeys: PublicKey[],
    label: string,
  ): Promise<(AccountInfo<Buffer> | null)[]> {
    const results: (AccountInfo<Buffer> | null)[] = [];
    // do it in serial, why?
    for (let i = 0; i < pubkeys.length; i += 100) {
      const slice = pubkeys.slice(i, i + 100);
      console.log(
        `batchGetMultipleAccountsInfo(${label}) - getMultipleAccountsInfo`,
        `${slice.length}/${pubkeys.length}`,
      );
      const infos = await this.connection.getMultipleAccountsInfo(slice);
      results.push(...infos);
    }
    return results;
  }

  verifySignature({
    publicKeyBase58,
    message,
    signatureBase64,
  }: {
    message: string;
    signatureBase64: string;
    publicKeyBase58: string;
  }): boolean {
    const signature = Uint8Array.from(Buffer.from(signatureBase64, "base64"));
    const messageUint8 = Uint8Array.from(Buffer.from(message, "utf-8"));
    const publicKeyBytes = bs58.decode(publicKeyBase58);

    return nacl.sign.detached.verify(messageUint8, signature, publicKeyBytes);
  }

  // Solana should be here, it's already in the class/service name
  // deprecate
  verifySolanaSignature({
    message,
    signatureBase64,
    publicKeyBase58,
  }: {
    message: string;
    signatureBase64: string;
    publicKeyBase58: string;
  }): boolean {
    this.runtime.logger.warn(
      "verifySolanaSignature is deprecated, use verifySignature",
    );
    return this.verifySignature({ message, signatureBase64, publicKeyBase58 });
  }

  //
  // MARK: Addresses
  //

  public isValidAddress(address: string, onCurveOnly = false): boolean {
    try {
      const pubkey = new PublicKey(address);
      if (onCurveOnly) {
        return PublicKey.isOnCurve(pubkey.toBuffer());
      }
      return true;
    } catch {
      return false;
    }
  }

  // Solana should be here, it's already in the class/service name
  // deprecate
  public isValidSolanaAddress(address: string, onCurveOnly = false): boolean {
    this.runtime.logger.warn(
      "isValidSolanaAddress is deprecated, use isValidAddress",
    );
    return this.isValidAddress(address, onCurveOnly);
  }

  /**
   * Validates a Solana address.
   * @param {string | undefined} address - The address to validate.
   * @returns {boolean} True if the address is valid, false otherwise.
   */
  public validateAddress(address: string | undefined): boolean {
    if (!address) return false;
    try {
      // Handle Solana addresses
      if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) {
        this.runtime.logger.warn(`Invalid Solana address format: ${address}`);
        return false;
      }

      const pubKey = new PublicKey(address);
      const isValid = Boolean(pubKey.toBase58());
      //logger.log(`Solana address validation: ${address}`, { isValid });
      return isValid;
    } catch (error) {
      //logger.error(`Address validation error: ${address} - ${error}`);
      this.runtime.logger.error(
        { error },
        `Address validation error: ${address}`,
      );
      return false;
    }
  }

  // getParsedAccountInfo
  private static readonly TOKEN_ACCOUNT_DATA_LENGTH = 165;
  private static readonly TOKEN_MINT_DATA_LENGTH = 82;

  // deprecate
  async getAddressType(address: string): Promise<string> {
    const types = await this.getAddressesTypes([address]);
    const result = types[address];
    if (result === undefined) {
      throw new Error(`Address type not found for ${address}`);
    }
    return result;
  }

  async getAddressesTypes(
    addresses: string[],
  ): Promise<Record<string, string>> {
    const pubkeys = addresses.map((a) => new PublicKey(a));
    const infos = await this.batchGetMultipleAccountsInfo(
      pubkeys,
      "getAddressesTypes",
    );

    const resultList: string[] = addresses.map((_addr, i) => {
      const info = infos[i];
      if (!info) return "Account does not exist";
      const dataLength = info.data.length;
      if (dataLength === 0) return "Wallet";
      if (dataLength === SolanaService.TOKEN_ACCOUNT_DATA_LENGTH)
        return "Token Account";
      if (dataLength === SolanaService.TOKEN_MINT_DATA_LENGTH) return "Token";
      return `Unknown (Data length: ${dataLength})`;
    });

    const out: Record<string, string> = {};
    for (let i = 0; i < addresses.length; i++) {
      const addr = addresses[i];
      if (addr !== undefined) {
        out[addr] = resultList[i] ?? "Unknown";
      }
    }

    return out;
  }

  /**
   * Detect Solana public keys (Base58) in a string
   * @param input arbitrary text
   * @param checkCurve whether to verify the key is on the Ed25519 curve via @solana/web3.js
   * @returns list of detected public key strings
   */
  public detectPubkeysFromString(
    input: string,
    checkCurve = false,
  ): Array<string> {
    const results = new Set<string>();
    const regex = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g;
    let match: RegExpExecArray | null;

    while ((match = regex.exec(input)) !== null) {
      const s = match[0];
      try {
        const buf = bs58.decode(s);
        if (buf.length === 32) {
          if (checkCurve) {
            if (PublicKey.isOnCurve(buf)) {
              results.add(s);
            }
          } else {
            results.add(s);
          }
        }
      } catch {
        // Not valid Base58
      }
    }

    return Array.from(results);
  }

  /**
   * Detect Solana private keys in a string.
   *
   * ⚠️ SECURITY WARNING: This method handles sensitive private key material.
   * - Never log or expose the returned bytes
   * - Clear sensitive data from memory after use
   * - Consider if this method should be public
   *
   * Supports:
   * - Base58 (≈88 chars, representing 64 bytes → 512 bits)
   * - Hexadecimal (128 hex chars → 64 bytes)
   *
   * Returns an array of objects with the original match and decoded bytes.
   */
  public detectPrivateKeysFromString(input: string): Array<{
    format: "base58" | "hex";
    match: string;
    bytes: Uint8Array;
  }> {
    const results: Array<{
      format: "base58" | "hex";
      match: string;
      bytes: Uint8Array;
    }> = [];

    // Base58 regex (no 0,O,I,l)
    const base58Regex = /\b[1-9A-HJ-NP-Za-km-z]{86,90}\b/g;
    // Hex regex: 128 hex chars
    const hexRegex = /\b[a-fA-F0-9]{128}\b/g;

    let m: RegExpExecArray | null;

    // Check Base58 matches
    while ((m = base58Regex.exec(input)) !== null) {
      const s = m[0];
      try {
        const buf = bs58.decode(s);
        if (buf.length === 64) {
          results.push({
            format: "base58",
            match: s,
            bytes: Uint8Array.from(buf),
          });
        }
      } catch {
        // invalid base58 — ignore
      }
    }

    // Check hex matches
    while ((m = hexRegex.exec(input)) !== null) {
      const s = m[0];
      const buf = Buffer.from(s, "hex");
      if (buf.length === 64) {
        results.push({ format: "hex", match: s, bytes: Uint8Array.from(buf) });
      }
    }

    return results;
  }

  //
  // MARK: tokens
  //

  // deprecate
  async getCirculatingSupply(mint: string) {
    //const mintPublicKey = new PublicKey(mint);
    // 1. Fetch all token accounts holding this token
    const accounts = await this.connection.getParsedProgramAccounts(
      TOKEN_PROGRAM_ID,
      {
        filters: [
          { dataSize: 165 }, // size of token account
          { memcmp: { offset: 0, bytes: mint } }, // filter by mint
        ],
      },
    );

    const KNOWN_EXCLUDED_ACCOUNTS = [
      "MINT_AUTHORITY_WALLET",
      "TREASURY_WALLET",
      "BURN_ADDRESS",
    ];

    // 2. Sum balances
    let circulating = 0;
    for (const acc of accounts) {
      const info = (acc.account.data as any).parsed.info;
      const owner = info.owner;

      // Optional: exclude burn address or known treasury/mint holding
      if (owner === "11111111111111111111111111111111") continue;
      if (KNOWN_EXCLUDED_ACCOUNTS.includes(owner)) continue;

      const amount = Number(info.tokenAmount.amount);
      const decimals = info.tokenAmount.decimals;
      circulating += amount / 10 ** decimals;
    }

    return circulating;
  }

  async getCirculatingSupplies(mints: string[]) {
    // FIXME: use batchGetMultipleAccountsInfo? to efficiently check multiple
    return Promise.all(mints.map((m) => this.getCirculatingSupply(m)));
  }

  /**
   * Asynchronously fetches the prices of SOL, BTC, and ETH tokens.
   * Uses cache to store and retrieve prices if available.
   * @returns A Promise that resolves to an object containing the prices of SOL, BTC, and ETH tokens.
   */
  private async fetchPrices(): Promise<Prices> {
    const cacheKey = "prices_sol_btc_eth";
    const cachedValue = await this.runtime.getCache<Prices>(cacheKey);

    // if cachedValue is JSON, parse it
    // FIXME: how long do we cache this for?!?
    if (cachedValue) {
      logger.log("Cache hit for fetchPrices");
      return cachedValue;
    }

    logger.log("Cache miss for fetchPrices");
    const { SOL, BTC, ETH } = PROVIDER_CONFIG.TOKEN_ADDRESSES;
    const tokens = [SOL, BTC, ETH];
    const prices: Prices = {
      solana: { usd: "0" },
      bitcoin: { usd: "0" },
      ethereum: { usd: "0" },
    };

    for (const token of tokens) {
      const response = (await this.birdeyeFetchWithRetry(
        `${PROVIDER_CONFIG.BIRDEYE_API}/defi/price?address=${token}`,
      )) as any;

      const responseData = response && response.data;
      if (responseData && responseData.value) {
        const price = responseData.value.toString();
        prices[
          token === SOL ? "solana" : token === BTC ? "bitcoin" : "ethereum"
        ].usd = price;
      }
    }

    await this.runtime.setCache<Prices>(cacheKey, prices);
    return prices;
  }

  public async getDecimal(mintPublicKey: PublicKey): Promise<number> {
    try {
      const key = mintPublicKey.toString();
      if (this.decimalsCache.has(key)) {
        console.log("getDecimal - HIT", key);
        return this.decimalsCache.get(key)!;
      }

      console.log("getDecimal - MISS getParsedAccountInfo", key);
      const acc = await this.connection.getParsedAccountInfo(mintPublicKey);
      const accValue = acc.value;
      const owner = accValue && accValue.owner ? accValue.owner.toString() : undefined;

      if (owner === TOKEN_PROGRAM_ID.toString()) {
        //const mintPublicKey = new PublicKey(mintAddress);
        console.log("getDecimal - MISS getMint", key);
        const mintInfo = await getMint(this.connection, mintPublicKey);
        //console.log('getDecimal - mintInfo', mintInfo)
        this.decimalsCache.set(key, mintInfo.decimals);
        return mintInfo.decimals;
      } else if (owner === TOKEN_2022_PROGRAM_ID.toString()) {
        const mintInfo = await getMint(
          this.connection,
          mintPublicKey,
          undefined, // optional commitment
          TOKEN_2022_PROGRAM_ID, // specify the extensions token program
        );
        // address, mintAuthority, supply, decimals, isInitialized, freezeAuthority, tlvData
        //console.log('getDecimal - mintInfo2022', mintInfo)
        this.decimalsCache.set(key, mintInfo.decimals);
        return mintInfo.decimals;
      }
      console.error(`Unknown owner type ${owner}`, acc);
      return -1;
    } catch (error) {
      // this will fail on a token2022 token
      console.error(`Failed to fetch token decimals: ${error}`);
      //throw error;
      return -1;
    }
  }

  public async getDecimals(mints: string[]): Promise<number[]> {
    const mintPublicKeys = mints.map((a) => new PublicKey(a));
    return Promise.all(mintPublicKeys.map((a) => this.getDecimal(a)));
  }

  public async getMetadataAddress(mint: PublicKey): Promise<PublicKey> {
    // not an rpc call
    const [metadataPDA] = await PublicKey.findProgramAddress(
      [
        Buffer.from("metadata"),
        METADATA_PROGRAM_ID.toBuffer(),
        mint.toBuffer(),
      ],
      METADATA_PROGRAM_ID,
    );
    return metadataPDA;
  }

  // FIXME: cache me...
  public async getTokenSymbol(mint: PublicKey): Promise<string | null> {
    const metadataAddress = await this.getMetadataAddress(mint);
    console.log("getTokenSymbol - getAccountInfo");
    const accountInfo = await this.connection.getAccountInfo(metadataAddress);

    if (!accountInfo || !accountInfo.data) return null;

    const data = accountInfo.data;
    //console.log('data', data)

    // Skip the 1-byte key and 32+32+4+len name fields (you can parse these if needed)
    let offset = 1 + 32 + 32;

    // Name (length-prefixed string)
    const nameLen = data.readUInt32LE(offset);
    offset += 4 + nameLen;
    //console.log('nameLen', nameLen)

    // Symbol (length-prefixed string)
    const symbolLen = data.readUInt32LE(offset);
    offset += 4;
    //console.log('symbolLen', symbolLen)

    const symbol = data
      .slice(offset, offset + symbolLen)
      .toString("utf8")
      .replace(/\0/g, "");
    //console.log('symbol', symbol)
    return symbol;
  }

  // this is all local
  private parseToken2022SymbolFromMintOrPtr = (
    mintData: Buffer,
  ): { symbol: string | null; ptr?: PublicKey } => {
    // Try inline TokenMetadata extension first
    const inline = getExtensionData(ExtensionType.TokenMetadata, mintData);
    if (inline) {
      try {
        const md = unpackToken2022Metadata(inline);
        const mdSymbol = md && md.symbol;
        const symbol = mdSymbol ? mdSymbol.replace(/\0/g, "").trim() : null;
        return { symbol };
      } catch {
        // fall through to pointer
      }
    }

    // Try MetadataPointer extension
    const ptrExt = getExtensionData(
      ExtensionType.MetadataPointer,
      mintData,
    ) as { authority: Uint8Array; metadataAddress: Uint8Array } | null;

    if (ptrExt && ptrExt.metadataAddress) {
      return { symbol: null, ptr: new PublicKey(ptrExt.metadataAddress) };
    }

    return { symbol: null };
  };

  // cache me
  public async getTokensSymbols(
    mints: string[],
  ): Promise<Record<string, string | null>> {
    console.log("getTokensSymbols");
    const mintKeys: PublicKey[] = mints.map((k) => new PublicKey(k));

    // Phase 1: Metaplex PDAs (your existing flow)
    const metadataAddresses: PublicKey[] = await Promise.all(
      mintKeys.map((mk) => this.getMetadataAddress(mk)),
    );
    const accountInfos = await this.batchGetMultipleAccountsInfo(
      metadataAddresses,
      "getTokensSymbols/Metaplex",
    );

    const out: Record<string, string | null> = {};
    const needs2022: PublicKey[] = [];

    mintKeys.forEach((token, i) => {
      const accountInfo = accountInfos[i]; // AccountInfo<Buffer> | null

      if (!accountInfo || !accountInfo.data) {
        out[token.toBase58()] = null;
        console.log(
          "getTokensSymbols - adding",
          token.toBase58(),
          "to token2022 list",
        );
        needs2022.push(token);
        return;
      }

      try {
        const data = accountInfo.data as Buffer;

        // @metaplex-foundation/mpl-token-metadata
        // Minimal Metaplex parse:
        // key(1) + updateAuth(32) + mint(32)
        let offset = 1 + 32 + 32;

        // name
        const nameLen = data.readUInt32LE(offset);
        offset += 4 + nameLen;

        // symbol
        const symbolLen = data.readUInt32LE(offset);
        offset += 4;
        const symbol =
          data
            .slice(offset, offset + symbolLen)
            .toString("utf8")
            .replace(/\0/g, "")
            .trim() || null;

        out[token.toBase58()] = symbol;
        if (!symbol) needs2022.push(token);
      } catch (e) {
        console.log("Metaplex parse failed; will try Token-2022:", e);
        out[token.toBase58()] = null;
        needs2022.push(token);
      }
    });

    // Phase 2: Batch fetch *mint accounts* via your batch helper, then parse Token-2022 TLV
    if (needs2022.length) {
      const mintInfos = await this.batchGetMultipleAccountsInfo(
        needs2022,
        "getTokensSymbols/Token2022",
      );

      // First pass: parse inline metadata or collect pointer addresses
      const ptrsToFetch: PublicKey[] = [];
      const ptrOwnerByKey = new Map<string, string>(); // mint base58 -> owner key (for logging)

      needs2022.forEach((mint, idx) => {
        const info = mintInfos[idx] as AccountInfo<Buffer> | null;
        if (!info || !info.data) {
          console.log("getTokensSymbols - token2022 failed", mint.toBase58());
          return;
        }
        if (!info.owner.equals(TOKEN_2022_PROGRAM_ID)) {
          console.log("getTokensSymbols - not a token2022", mint.toBase58());
          return;
        }

        const { symbol, ptr } = this.parseToken2022SymbolFromMintOrPtr(
          info.data,
        );
        if (symbol) {
          out[mint.toBase58()] = symbol;
        } else if (ptr) {
          ptrsToFetch.push(ptr);
          ptrOwnerByKey.set(ptr.toBase58(), mint.toBase58());
        } else {
          console.log(
            "getTokensSymbols - no TokenMetadata or pointer",
            mint.toBase58(),
          );
        }
      });

      // Second pass: fetch and parse pointer accounts (batch)
      if (ptrsToFetch.length) {
        const pointerInfos = await this.batchGetMultipleAccountsInfo(
          ptrsToFetch,
          "getTokensSymbols/Token2022Pointer",
        );

        ptrsToFetch.forEach((ptrPk, idx) => {
          const pinfo = pointerInfos[idx] as AccountInfo<Buffer> | null;
          const mintB58 = ptrOwnerByKey.get(ptrPk.toBase58())!;
          if (!pinfo || !pinfo.data) {
            console.log(
              "getTokensSymbols - pointer account missing",
              ptrPk.toBase58(),
              "for mint",
              mintB58,
            );
            return;
          }
          try {
            const md = unpackToken2022Metadata(pinfo.data);
            const mdSymbol = md && md.symbol;
            const symbol = mdSymbol ? mdSymbol.replace(/\0/g, "").trim() : null;
            if (symbol) {
              out[mintB58] = symbol;
            } else {
              console.log(
                "getTokensSymbols - pointer metadata has no symbol",
                ptrPk.toBase58(),
                "for mint",
                mintB58,
              );
            }
          } catch (e) {
            console.log(
              "getTokensSymbols - failed to unpack pointer metadata",
              ptrPk.toBase58(),
              e,
            );
          }
        });
      }
    }

    return out;
  }

  public async getSupply(CAs: string[]) {
    //console.log('getSupply CAs', CAs.length)
    const mintKeys: PublicKey[] = CAs.map((ca: string) => new PublicKey(ca));
    const mintInfos = await this.batchGetMultipleAccountsInfo(
      mintKeys,
      "getSupply",
    );

    const results = mintInfos.map((accountInfo, idx) => {
      if (!accountInfo) {
        return { address: CAs[idx], error: "Account not found" };
      }

      // accountInfo.data is a Node Buffer; make a Uint8Array *view* (no copy)
      const buf = accountInfo.data as Buffer;
      const u8 = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);

      // MintLayout.decode accepts Uint8Array (and Buffer). Use u8 to avoid type fuss.
      const mint = MintLayout.decode(u8);

      // Normalize types
      const decimals: number = mint.decimals;
      const supply: bigint = BigInt(mint.supply.toString()); // ensure bigint

      // bigint-safe 10^decimals
      let _denom = 1n;
      for (let i = 0; i < decimals; i++) _denom *= 10n;

      return {
        address: CAs[idx],
        biSupply: supply, // keep as bigint for exactness
        // Human-readable (use BigNumber to avoid float issues for large values)
        human: new BigNumber(supply.toString()).dividedBy(10 ** decimals),
        decimals,
      };
    });

    // then convert to object
    const out = Object.fromEntries(
      results.map((r) => [
        r.address,
        {
          supply: r.biSupply,
          decimals: r.decimals,
          human: r.human,
        },
      ]),
    );
    // realSupply = supply / Math.pow(10, decimals)
    return out;
  }

  public async parseTokenAccounts(
    heldTokens: any[],
    options: { notOlderThan?: number } = {},
  ) {
    // decimalsCache means we don't need all I think
    // we need structure token cache
    // stil need them for symbol

    // ATAs?
    /*
    for(const t of heldTokens) {
      //pubkey / account
      // account: data, owner, space, lamports, rentEpoch, executables
      console.log('held', t.pubkey.toBase58(), t.account.data.program, t.account.data.parsed)
      // data: program, parsed, ??
      // parsed: type: "account", info
      // t22 info: extensions, isNative, mint, owner, state, tokenAmount (amount, decimals, uiAmount, uiAmountString)
      // spl info: isNative, mint, owner, state, tokenAmount (amount, decimals, uiAmount, uiAmountString)
    }
    */

    const nowInMs = Date.now();

    //console.log('cache', cache)

    //const mintKeys: PublicKey[] = []
    const acceptableInMs = options.notOlderThan ?? 60 * 60_000; // 1 hour default
    let cache = [];
    // what about immutable?
    if (acceptableInMs !== 0) {
      console.time("cacheCheck");
      cache = await Promise.all(
        heldTokens.map((t) =>
          this.runtime.getCache<any>(
            `solana_token_meta_${t.account.data.parsed.info.mint}`,
          ),
        ),
      );
      console.timeEnd("cacheCheck");
    }

    let misses = 0;
    const fetchTokens = [];
    const goodCache: Record<
      string,
      { isMutable: boolean } & Record<string, unknown> & { balanceUi: number }
    > = {};
    for (const i in heldTokens) {
      const t = heldTokens[i];
      if (cache[i]) {
        const c = cache[i];
        let useCache = false;
        if (c.data.isMutable === false) {
          // immutable data is always good
          useCache = true;
        } //otherwise
        else if (acceptableInMs !== 0) {
          const diff = nowInMs - c.setAt;
          //console.log('cache for', t.account.data.parsed.info.mint, 'is', diff.toLocaleString() + 'ms old')
          // freshness check
          if (diff < acceptableInMs) {
            useCache = true;
            //} else {
            //console.log('parseTokenAccounts - MISS', mint)
          }
        }
        //useCache = false
        if (useCache) {
          // HIT
          //console.log('parseTokenAccounts - HIT', mint)
          const mint = t.account.data.parsed.info.mint;
          //console.log('info', t.account.data.parsed.info)
          const { amount: raw, decimals } =
            t.account.data.parsed.info.tokenAmount;
          const balanceUi = Number(raw) / 10 ** decimals;

          goodCache[mint] = { ...c.data, balanceUi };
          continue;
        }
      }
      fetchTokens.push(heldTokens[i]);
      misses++;
    }
    this.runtime.logger.debug(
      "parseTokenAccounts havs",
      `${heldTokens.length - misses}/${heldTokens.length}`,
      "in cache (1hr default)",
    );

    //const mintKeys: PublicKey[] = heldTokens.map(t => new PublicKey(t.account.data.parsed.info.mint))

    // --- build unique mint sets by program ---
    const toB58 = (pk: string | PublicKey) =>
      typeof pk === "string" ? pk : pk.toBase58();

    const TOKEN_ID_B58 = TOKEN_PROGRAM_ID.toBase58();
    const TOKEN2022_B58 = TOKEN_2022_PROGRAM_ID.toBase58();

    const t22MintKeys: PublicKey[] = Array.from(
      new Set(
        fetchTokens
          .filter((t) => toB58(t.account.owner) === TOKEN2022_B58)
          .map((t) => t.account.data.parsed.info.mint as string),
      ),
    ).map((s) => new PublicKey(s));

    const classicMintKeys: PublicKey[] = Array.from(
      new Set(
        fetchTokens
          .filter((t) => toB58(t.account.owner) === TOKEN_ID_B58)
          .map((t) => t.account.data.parsed.info.mint as string),
      ),
    ).map((s) => new PublicKey(s));

    // --- phase 1: batch fetch Token-2022 mint *only* ---

    // we might want to get all keys here so we can get the supply
    const allMintKeys: PublicKey[] = Array.from(
      new Set(
        fetchTokens.map((t: any) => t.account.data.parsed.info.mint as string),
      ),
    ).map((s) => new PublicKey(s));

    //
    const mintInfos = await this.batchGetMultipleAccountsInfo(
      allMintKeys,
      "t22-mints",
    );

    /*
    const t22MintInfos = t22MintKeys.length
      ? await this.batchGetMultipleAccountsInfo(t22MintKeys, "t22-mints")
      : [];
    */

    // detect who has the TLV TokenMetadata extension
    const hasT22Meta = new Set<string>();
    // detect TLV + compute "isMutable" from updateAuthority (Some/None)
    const t22IsMutable = new Map<string, boolean>(); // mint -> isMutable

    /*
    function readT22IsMutable(ext: Buffer): { isMutable: boolean } {
      // Token-2022 TokenMetadata starts with Option<Pubkey>:
      // tag (u8: 0=None, 1=Some) + pubkey (32 bytes if Some), then name(32), symbol(10), uri(200)...
      const tag = ext.readUInt8(0);
      if (tag === 0) return { isMutable: false };            // no update authority → immutable
      if (tag === 1) return { isMutable: true };             // has update authority → mutable
      // defensive fallback if layout/version differs:
      return { isMutable: true };
    }
    */

    // top of the function (near other maps/sets)
    const t22Symbols = new Map<string, string>(); // mint -> symbol (Token-2022 TLV)
    const mpSymbols = new Map<string, string>(); // mint -> symbol (Metaplex PDA)
    const mpSupply = new Map<string, string>(); // mint -> supply

    // Trim trailing NULs and whitespace
    const stripNulls = (s: string) => s.replace(/\u0000+$/g, "").trim();
    // helper to read fixed-size, null-padded utf8 strings (Token-2022 TLV)
    /*
    function readFixedCString(buf: Buffer, start: number, len: number): string {
      const slice = buf.subarray(start, start + len);
      const nul = slice.indexOf(0);
      const end = nul >= 0 ? nul : slice.length;
      return stripNulls(slice.subarray(0, end).toString("utf8").trim());
    }
    */

    // Borsh-encoded string: u32 LE length + bytes (Metaplex PDA)
    function readBorshStringSafe(buf: Buffer, offObj: { off: number }): string {
      if (offObj.off + 4 > buf.length) return ""; // truncated
      const len = buf.readUInt32LE(offObj.off);
      offObj.off += 4;
      if (len < 0 || offObj.off + len > buf.length) {
        // corrupted length; consume the remainder to avoid infinite loops
        const bytes = buf.subarray(offObj.off, buf.length);
        offObj.off = buf.length;
        return stripNulls(bytes.toString("utf8"));
      }
      const bytes = buf.subarray(offObj.off, offObj.off + len);
      offObj.off += len;
      return stripNulls(bytes.toString("utf8"));
    }

    function readU32LE(buf: Buffer, offObj: { off: number }): number {
      if (offObj.off + 4 > buf.length) throw new Error("oob u32");
      const v = buf.readUInt32LE(offObj.off);
      offObj.off += 4;
      return v;
    }

    function readVecU8AsString(buf: Buffer, offObj: { off: number }): string {
      const len = readU32LE(buf, offObj);
      if (len < 0 || offObj.off + len > buf.length) throw new Error("oob str");
      const s = buf.subarray(offObj.off, offObj.off + len).toString("utf8");
      offObj.off += len;
      return s.trim();
    }
    function allZero32(b: Buffer) {
      for (let i = 0; i < 32; i++) if (b[i] !== 0) return false;
      return true;
    }

    // Parse the Token-2022 TokenMetadata TLV (just the Value slice)
    function parseToken2022MetadataTLV(ext: Buffer): {
      isMutable: boolean;
      updateAuthority?: string;
      mint: string;
      name: string;
      symbol: string;
      uri: string;
      additional?: unknown;
    } {
      const o = { off: 0 };
      // 32B updateAuthority (all-zero = None)
      const uaBytes = ext.subarray(o.off, o.off + 32);
      o.off += 32;
      const isMutable = !allZero32(uaBytes);
      const updateAuthority = isMutable
        ? new PublicKey(uaBytes).toBase58()
        : undefined;

      // 32B mint
      const mint = new PublicKey(ext.subarray(o.off, o.off + 32)).toBase58();
      o.off += 32;

      // Strings
      const name = readVecU8AsString(ext, o);
      const symbol = readVecU8AsString(ext, o);
      //console.log('t22 symbol', symbol)
      const uri = readVecU8AsString(ext, o);

      // Optional Vec<(String,String)>
      const additional: Array<[string, string]> = [];
      if (o.off + 4 <= ext.length) {
        const n = readU32LE(ext, o);
        for (let i = 0; i < n; i++)
          additional.push([
            readVecU8AsString(ext, o),
            readVecU8AsString(ext, o),
          ]);
      }
      return {
        isMutable,
        ...(updateAuthority !== undefined && { updateAuthority }),
        mint,
        name,
        symbol,
        uri,
        ...(additional.length > 0 && { additional }),
      };
    }

    function formatSupplyUiAmount(amount: bigint, decimals: number): string {
      let denom = 1n;
      for (let i = 0; i < decimals; i++) denom *= 10n;

      const whole = amount / denom;
      const frac = (amount % denom).toString().padStart(decimals, "0");
      return decimals === 0
        ? whole.toString()
        : `${whole}.${frac}`.replace(/\.$/, "");
    }

    //console.log('t22MintKeys', t22MintKeys.length)
    //t22MintKeys.forEach((mk, i) => {
    allMintKeys.forEach((mk, i) => {
      //const info = t22MintInfos[i];
      const info = mintInfos[i];

      if (!info || !info.data) return;
      //console.log('token22 info', mk.toBase58(), info)
      // lamports, data, owner, executable, rentEpoch, space

      // 1) Sanity: owner must be TOKEN_2022_PROGRAM_ID
      const infoOwner = info.owner;
      const isT22 =
        infoOwner && infoOwner.toBase58 && infoOwner.toBase58() === TOKEN_2022_PROGRAM_ID.toBase58();
      //if (!isT22) {
      //console.warn("mint not owned by TOKEN_2022", mk.toBase58(), info.owner?.toBase58?.());
      //}

      // 2) List all extensions present
      //const exts = getExtensionTypes(info.data); // returns ExtensionType[]
      //console.log(mk.toBase58(), "extensions:", exts.map(x => ExtensionType[x] ?? x));
      const mintKeyStr = mk.toBase58();

      if (isT22) {
        const parsedMint = unpackMint(mk, info, TOKEN_2022_PROGRAM_ID);
        // parsedMint.address.toBase58(), is the same as mintKeyStr
        const uiSupply = formatSupplyUiAmount(
          parsedMint.supply,
          parsedMint.decimals,
        );
        //console.log('t22', mintKeyStr, 'parsedMint', parsedMint.supply, parsedMint.decimals, '=>', uiSupply)
        // address, mintAuthority, supply, decimals, isInitialized, freezeAuthority, tlvData

        mpSupply.set(mintKeyStr, uiSupply); // as BigNumber
        if (this.decimalsCache.get(mintKeyStr) !== parsedMint.decimals) {
          console.log(
            "decimalsCache",
            this.decimalsCache.get(mintKeyStr),
            "!== parsedMint.decimals",
            parsedMint.decimals,
          );
        }
        this.decimalsCache.set(mintKeyStr, parsedMint.decimals);
        // not sure this is right
        // address, mintAuthority, supply, decimals, isInitialized, freezeAuthority, tlvData

        const tlv = parsedMint.tlvData ?? Buffer.alloc(0);
        //const exts2 = getExtensionTypes(tlv);
        //console.log(mk.toBase58(), "extensions:", exts2.map(x => ExtensionType[x] ?? x));

        // TokenMetadata TLV
        const mdExt = getExtensionData(ExtensionType.TokenMetadata, tlv);
        if (mdExt) {
          //console.log('tlv mdExt', mdExt)
          const res = parseToken2022MetadataTLV(mdExt);
          //console.log('res', res)

          hasT22Meta.add(mintKeyStr);
          t22IsMutable.set(mintKeyStr, res.isMutable);
          t22Symbols.set(mintKeyStr, res.symbol);

          /*
          //const res2 = parseToken2022MetadataTLV(tlv)
          //console.log('res2', res2)
          console.log('token22 has ext.TokenMetadata', mk.toBase58())

          const tag = mdExt.readUInt8(0);       // 0=None, 1=Some(updateAuthority)
          let off = 1 + (tag === 1 ? 32 : 0);
          const name   = readFixedCString(mdExt, off, 32); off += 32;
          const symbol = readFixedCString(mdExt, off, 10); off += 10;
          console.log('t22', symbol)
          hasT22Meta.add(mk.toBase58());
          t22IsMutable.set(mk.toBase58(), tag === 1);
          t22Symbols.set(mk.toBase58(), symbol);
          */
          return;
        }
      } else {
        // spl token
        const infoData = info && info.data;
        const buf = infoData as Buffer;
        const u8 = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);

        // slice the header as a Uint8Array, not Buffer
        const header = u8.subarray(0, MintLayout.span);
        const mintData = MintLayout.decode(header);
        //console.log('spl mintData', mintData)
        const uiSupply = formatSupplyUiAmount(
          mintData.supply,
          mintData.decimals,
        );
        //console.log('spl', mintKeyStr, 'mintData', mintData.supply, mintData.decimals, '=>', uiSupply.toLocaleString())
        mpSupply.set(mintKeyStr, uiSupply); // as BigNumber
        if (this.decimalsCache.get(mintKeyStr) !== mintData.decimals) {
          console.log(
            "decimalsCache",
            this.decimalsCache.get(mintKeyStr),
            "!== mintData.decimals",
            mintData.decimals,
          );
        }
        this.decimalsCache.set(mintKeyStr, mintData.decimals);
      }

      /*
      const ext = getExtensionData(ExtensionType.TokenMetadata, info.data);
      if (ext) {
        console.log('token22 has ext', mk.toBase58())

        // mutable
        hasT22Meta.add(mk.toBase58());
        t22IsMutable.set(mk.toBase58(), readT22IsMutable(ext).isMutable);

        // symbol
        // decode fixed fields: name(32), symbol(10), uri(200)
        let off = 1 + (tag === 1 ? 32 : 0); // skip tag + optional pubkey
        const name   = readFixedCString(ext, off, 32); off += 32;
        const symbol = readFixedCString(ext, off, 10); off += 10;
        console.log('t22 name', name, 'symbol', symbol)
        // (uri would be at off with length 200 if you need it)

        t22Symbols.set(mk.toBase58(), symbol);
        return;
      }
      // Fallback: check for Metadata Pointer extension
      const ptrExt = getExtensionData(ExtensionType.MetadataPointer, info.data);
      if (!ptrExt) {
        console.log('token22 no metaplex info')
        return;
      }

      // Layout: 32 bytes authority + 32 bytes metadataAddress
      if (ptrExt.length < 64) {
        console.warn("MetadataPointer too short", mk.toBase58(), ptrExt.length);
        return;
      }
      const metaAddr = new PublicKey(ptrExt.subarray(32, 64));
      const mint58 = mk.toBase58();
      t22PtrAddrByMint.set(mint58, metaAddr);
      t22PtrMintByAddr.set(metaAddr.toBase58(), mint58);
      */
    });

    // --- phase 2: fetch ONLY the Metaplex PDAs we actually need ---
    // (classic mints + Token-2022 mints that DON'T have the TLV)
    const missingT22s = t22MintKeys.filter(
      (m) => !hasT22Meta.has(m.toBase58()),
    );
    console.log("missingT22s", missingT22s.length);
    const mpMintKeys = [...classicMintKeys, ...missingT22s];

    //console.log('mpMintKeys', mpMintKeys.length)

    const mpAddrs: PublicKey[] = await Promise.all(
      mpMintKeys.map((m) => this.getMetadataAddress(m)),
    );
    const mpInfos = mpAddrs.length
      ? await this.batchGetMultipleAccountsInfo(mpAddrs, "metaplex-md")
      : [];

    // parse Metaplex isMutable (u8) after primarySaleHappened
    const mpIsMutable = new Map<string, boolean>(); // mint -> isMutable
    mpMintKeys.forEach((mk, i) => {
      const acc = mpInfos[i];
      //console.log('acc', acc)
      // metadata address
      // lamports, data, owner, executable, rentEpoch, space
      const accData = acc && acc.data;
      const data = accData;
      if (!data || !data.length) return;
      //if (!data || data.length < MintLayout.span) return; // must be a mint account

      const mintAddrStr = mk.toBase58();

      /*
      if (classicMintKeys.find(k => k.equals(mk))) {
        const header = data.subarray(0, MintLayout.span);
        const mintData = MintLayout.decode(header);
        console.log('classic', mintData)
      } else {
        console.log('t22')
      }
      */

      /*
      const header = data.subarray(0, MintLayout.span);
      const mintData = MintLayout.decode(header);

      const rawSupply = BigInt(mintData.supply.toString()); // BN -> bigint
      const decimals  = mintData.decimals as number;
      const isInit    = !!mintData.isInitialized;
      console.log('rawSupply', rawSupply2, 'decimals', decimals)

      const uiSupply = Number(rawSupply) / 10 ** mintData.decimals;
      console.log('mintData', mintData)
      mpSupply.set(mintAddrStr, uiSupply)
      */

      const limit = data.length;
      const need = (n: number) => n <= limit;

      const off = 1 + 32 + 32; // key + updateAuthority + mint
      if (!need(off)) return;

      const offObj = { off };
      /* const name = */ readBorshStringSafe(data, offObj);
      const symbol = readBorshStringSafe(data, offObj);
      /* const uri = */ readBorshStringSafe(data, offObj);

      if (offObj.off + 2 > limit) return;
      /* const sellerFee = */ data.readUInt16LE(offObj.off);
      offObj.off += 2;

      if (offObj.off + 1 > limit) return;
      const hasCreators = data.readUInt8(offObj.off);
      offObj.off += 1;

      if (hasCreators) {
        if (offObj.off + 4 > limit) return;
        const n = data.readUInt32LE(offObj.off);
        offObj.off += 4;
        const creatorSize = 32 + 1 + 1;
        const bytesNeeded = n * creatorSize;
        if (offObj.off + bytesNeeded > limit) return;
        offObj.off += bytesNeeded;
      }

      if (offObj.off + 1 > limit) return; // primarySaleHappened (u8)
      offObj.off += 1;

      if (offObj.off + 1 > limit) return; // isMutable (u8)
      const isMutable = data.readUInt8(offObj.off) === 1;

      mpIsMutable.set(mintAddrStr, isMutable);
      mpSymbols.set(mintAddrStr, symbol);
    });

    /*
    // --- build the Metaplex PDA list we actually need ---
    const mintsNeedingMP = [
      ...classicMintKeys,
      ...t22MintKeys.filter(mk => !hasT22Meta.has(mk.toBase58())),
    ];
    const mpAddrs = await Promise.all(mintsNeedingMP.map(m => this.getMetadataAddress(m)));

    // --- one "mega" batch: t22 mints (already fetched) + needed PDAs ---
    const allAddrs: PublicKey[] = [...mintsNeedingMP, ...t22MintKeys].map((pk, i) => pk); // just to show the idea
    const allInfos = await this.batchGetMultipleAccountsInfo(
      [...mpAddrs, ...t22MintKeys],                 // << one RPC call in your helper (it can chunk internally)
      "mega"
    );
    // --- quick indexers by address ---
    const infoByAddr = new Map<string, any>();
    [...mpAddrs, ...t22MintKeys].forEach((pk, i) => infoByAddr.set(pk.toBase58(), allInfos[i]));

    // helper getters
    const getMpInfo   = (mint: PublicKey) => infoByAddr.get((await this.getMetadataAddress(mint)).toBase58()) ?? null;
    const getT22Mint  = (mint: PublicKey) => infoByAddr.get(mint.toBase58()) ?? null;
    */

    const t22Set = new Set(t22MintKeys.map((k) => k.toBase58()));

    const results = heldTokens.map((t) => {
      const mintStr: string = t.account.data.parsed.info.mint as string;
      const mintKey: PublicKey = new PublicKey(mintStr);
      const is2022: boolean = t22Set.has(mintStr);

      // decimals / balance (unchanged)
      const { amount: raw, decimals } = t.account.data.parsed.info.tokenAmount;
      const balanceUi: number = Number(raw) / 10 ** decimals;

      // pick the right source for isMutable
      const isMutable: boolean | null =
        is2022 && hasT22Meta.has(mintStr)
          ? (t22IsMutable.get(mintStr) ?? null)
          : (mpIsMutable.get(mintStr) ?? null);

      const symbol: string | null =
        is2022 && hasT22Meta.has(mintStr)
          ? (t22Symbols.get(mintStr) ?? null)
          : (mpSymbols.get(mintStr) ?? null);

      let supply: string | number | null = mpSupply.get(mintStr) ?? null;
      if (supply) supply = parseFloat(supply);

      return {
        mint: mintKey.toBase58(),
        symbol,
        supply,
        tokenProgram: is2022 ? "Token-2022" : "Token",
        decimals,
        balanceUi,
        isMutable, // boolean | null
      };
    });

    /*
    //const mintInfos = await this.batchGetMultipleAccountsInfo(t22MintKeys, "parseTokenAccounts-t22-mints")
    //const accountInfos = await this.batchGetMultipleAccountsInfo(metadataAddresses, 'parseTokenAccounts')

    const [mintInfos, accountInfos] = await Promise.all([
      this.batchGetMultipleAccountsInfo(t22MintKeys, "parseTokenAccounts-t22-mints"),
      this.batchGetMultipleAccountsInfo(metadataAddresses, 'parseTokenAccounts'),
    ])
    const t22MetaByMint = new Map<string, { name: string; symbol: string; uri: string } | null>();
    t22MintKeys.forEach((mintKey, i) => {
      const info = mintInfos[i];
      if (!info || !info.data) { t22MetaByMint.set(mintKey.toBase58(), null); return; }
      const ext = getExtensionData(ExtensionType.TokenMetadata, info.data);
      if (!ext) { t22MetaByMint.set(mintKey.toBase58(), null); return; }
      t22MetaByMint.set(mintKey.toBase58(), decodeT22TokenMetadata(ext));
    });
    */

    //console.log('parseTokenAccounts - getMultipleAccountsInfo')
    //const accountInfos = await this.connection.getMultipleAccountsInfo(metadataAddresses);
    //console.log('accountInfos', accountInfos) // works

    /*
    const results = heldTokens.map((token: any, i: number) => {
      const metadataInfo = accountInfos[i];      // raw AccountInfo | null
      //console.log('metadataInfo', metadataInfo)
      const mintKey      = mintKeys[i];

      const metadataInfoOwner = metadataInfo && metadataInfo.owner;
      const mintOwner = metadataInfoOwner; // PublicKey | undefined
      const isToken2022 = !!mintOwner && mintOwner.equals(TOKEN_2022_PROGRAM_ID);
      const isClassic   = !!mintOwner && mintOwner.equals(TOKEN_PROGRAM_ID);

      if (metadataInfo === null) {
        // what's going on with these? atas?
        // NFTs and token2022
        console.log('mdInfo null for', mintKey.toBase58())
      }

      // ----- Metaplex metadata deserialisation -----
      let symbol: string | null = null;
      let updateAuthority: PublicKey | null = null;
      let isMutable: boolean | null = null;

      function readString(data: Buffer, offset: number) {
        const len = data.readUInt32LE(offset);
        const start = offset + 4;
        const end = start + len;
        const value = data.slice(start, end).toString("utf8").replace(/\0/g, "");
        return { value, offset: end };
      }

      const metadataInfoData = metadataInfo && metadataInfo.data;
      if (metadataInfoData && metadataInfoData.length) {
        const data = metadataInfoData;

        // key (1) + updateAuthority (32) + mint (32)
        updateAuthority = new PublicKey(data.slice(1, 33));
        let offset = 1 + 32 + 32;

        // name
        ({ offset } = readString(data, offset));

        // symbol
        const sym = readString(data, offset);
        symbol = sym.value;
        offset = sym.offset;

        // uri
        ({ offset } = readString(data, offset));

        // sellerFeeBasisPoints (u16)
        offset += 2;

        // creators: Option<Vec<Creator>>
        const hasCreators = data.readUInt8(offset); offset += 1;
        if (hasCreators) {
          const n = data.readUInt32LE(offset); offset += 4;
          // each creator: 32 (pubkey) + 1 (verified) + 1 (share)
          offset += n * (32 + 1 + 1);
        }

        // primarySaleHappened (u8)
        const primarySaleHappened = data.readUInt8(offset) === 1; offset += 1;

        // isMutable (u8)
        isMutable = data.readUInt8(offset) === 1; offset += 1;

        // (Optional fields may follow; no need to parse them to get isMutable)
      }

      // ----- Token-account figures (already parsed) -----
      //console.log('accountdata', token.account.data.parsed)
      const { amount: raw, decimals } = token.account.data.parsed.info.tokenAmount;
      this.decimalsCache.set(mintKey, decimals);

      //if (mintKey.toBase58() !== token.account.data.parsed.info.mint) {
        //console.log('NOT_EQUAL', mintKey, token.account.data.parsed.info.mint)
      //}

      if (!isMutable) {
        //console.log('hard caching', mintKey)
      }

      const balanceUi = Number(raw) / 10 ** decimals;


      return {
        mint: mintKey.toBase58(),
        symbol,
        decimals,
        balanceUi,
      };
    });
    */
    // an array
    //console.log('results', results[0]) // sample result

    // background slow save
    (async () => {
      console.time("saveCache");
      for (const t of results) {
        const copy: any = { ...t };
        delete copy.balanceUi;
        delete copy.mint;
        const key = `solana_token_meta_${t.mint}`;
        // we're just caching them all
        //console.log('need to cache', key)

        // one at a time because we'll get dead locks otherwise
        await this.runtime.setCache<any>(key, {
          setAt: nowInMs,
          data: copy,
        });
        /*
        if (t.isMutable === false) {
          delete copy.isMutable
          const key = 'solana_token_meta_' + t.mint
          console.log('need to hard cache', key)
          // could be a disk cache... to avoid db locking issues
          this.runtime.setCache<any>(key, {
            setAt: tsInMs,
            data: copy,
          });
        } else {
          const key = 'solana_token_muta_meta_' + t.mint
          console.log('need to soft cache', key)
          // could be a disk cache... to avoid db locking issues
          this.runtime.setCache<any>(key, {
            setAt: tsInMs,
            data: copy,
          });
        }
        */
      }
      console.timeEnd("saveCache");
    })().catch((err) =>
      console.error("solana:parseTokenAccounts - cache save failed:", err),
    );

    // then convert array to keyed object
    const out = Object.fromEntries(
      results.map((r: any) => [
        r.mint,
        {
          symbol: r.symbol,
          supply: r.supply,
          tokenProgram: r.tokenProgram,
          decimals: r.decimals,
          balanceUi: r.balanceUi,
          isMutable: r.isMutable,
        },
      ]),
    );

    /*
    for(const i in heldTokens) {
      if (goodCache[i]) {
        const t = heldTokens[i]
        const mint = t.account.data.parsed.info.mint
        console.log('loading', mint, 'from cache', t)
        out[mint] = goodCache[i]
        out[mint].balanceUi = t.balanceUi
        out[mint].isMutable = false
      }
    }
    */
    for (const mint in goodCache) {
      out[mint] = goodCache[mint];
    }

    //console.log('out', out)
    return out;
  }

  //
  // MARK: wallets
  //

  //
  // MARK: agent wallet
  //

  /**
   * Asynchronously fetches token accounts for a specific owner.
   *
   * @returns {Promise<any[]>} A promise that resolves to an array of token accounts.
   */
  private async getTokenAccounts() {
    const publicKey = await this.ensurePublicKey();
    if (!publicKey) return null;
    return this.getTokenAccountsByKeypair(publicKey);
  }

  /**
   * Gets the wallet keypair for operations requiring private key access
   * @returns {Promise<Keypair>} The wallet keypair
   * @throws {Error} If private key is not available
   */
  public async getWalletKeypair(): Promise<Keypair> {
    const keypair = await this.ensureKeypair();
    if (!keypair) {
      throw new Error("Failed to get wallet keypair");
    }
    return keypair;
  }

  /**
   * Retrieves the public key of the instance.
   *
   * @returns {Promise<PublicKey | null>} The public key of the instance.
   */
  public async getPublicKey(): Promise<PublicKey | null> {
    return await this.ensurePublicKey();
  }

  /**
   * Update wallet data including fetching wallet portfolio information, prices, and caching the data.
   * @param {boolean} [force=false] - Whether to force update the wallet data even if the update interval has not passed
   * @returns {Promise<WalletPortfolio>} The updated wallet portfolio information
   */
  public async updateWalletData(force = false): Promise<WalletPortfolio> {
    //console.log('updateWalletData - start')
    const now = Date.now();

    const publicKey = await this.ensurePublicKey();
    if (!publicKey) {
      // can't be warn if we fire every start up
      // maybe we just get the pubkey here proper
      // or fall back to SOLANA_PUBLIC_KEY
      logger.log("solana::updateWalletData - no Public Key yet");
      return { totalUsd: "0", items: [] };
    }

    //console.log('updateWalletData - force', force, 'last', this.lastUpdate, 'UPDATE_INTERVAL', this.UPDATE_INTERVAL)
    // Don't update if less than interval has passed, unless forced
    if (!force && now - this.lastUpdate < this.UPDATE_INTERVAL) {
      const cached = await this.getCachedData();
      if (cached) return cached;
    }
    //console.log('updateWalletData - fetch')

    try {
      // Try Birdeye API first
      const birdeyeApiKey = this.runtime.getSetting("BIRDEYE_API_KEY");
      if (birdeyeApiKey) {
        try {
          const walletData = (await this.birdeyeFetchWithRetry(
            `${PROVIDER_CONFIG.BIRDEYE_API}/v1/wallet/token_list?wallet=${publicKey.toBase58()}`,
          )) as any;
          // only good for checking envelope
          //console.log('walletData', walletData)

          const walletDataSuccess = walletData && walletData.success;
          const walletDataData = walletData && walletData.data;
          if (walletDataSuccess && walletDataData) {
            const data = walletDataData;
            const totalUsd = new BigNumber(data.totalUsd.toString());
            const prices = await this.fetchPrices();
            const solPriceInUSD = new BigNumber(prices.solana.usd);

            const missingSymbols = data.items.filter((i: any) => !i.symbol);

            //console.log('data.items', data.items)
            if (missingSymbols.length) {
              const symbols: Record<string, string | null> =
                await this.getTokensSymbols(
                  missingSymbols.map((i: any) => i.address),
                );
              let missing = false;
              for (const i in data.items) {
                const item = data.items[i];
                if (symbols[item.address]) {
                  data.items[i].symbol = symbols[item.address];
                } else {
                  console.log(
                    "solana::updateWalletData - no symbol for",
                    item.address,
                    symbols[item.address],
                  );
                  missing = true;
                }
              }
              if (missing) {
                console.log("symbols", symbols);
              }
            }

            const portfolio: WalletPortfolio = {
              totalUsd: totalUsd.toString(),
              totalSol: totalUsd.div(solPriceInUSD).toFixed(6),
              prices,
              lastUpdated: now,
              items: data.items.map((item: Item) => ({
                ...item,
                valueSol: new BigNumber(item.valueUsd || 0)
                  .div(solPriceInUSD)
                  .toFixed(6),
                name: item.name || "Unknown",
                symbol: item.symbol || "Unknown",
                priceUsd: item.priceUsd || "0",
                valueUsd: item.valueUsd || "0",
              })),
            };

            //console.log('saving portfolio', portfolio.items.length, 'tokens')

            // maybe should be keyed by public key
            await this.runtime.setCache<WalletPortfolio>(
              SOLANA_WALLET_DATA_CACHE_KEY,
              portfolio,
            );
            this.lastUpdate = now;
            return portfolio;
          }
        } catch (e) {
          console.log("solana::updateWalletData - exception err", e);
        }
      }

      // Fallback to basic token account info (without Birdeye)
      logger.log("Using RPC fallback for wallet data (no Birdeye)");
      const accounts = await this.getTokenAccounts();
      if (!accounts || accounts.length === 0) {
        logger.log("No token accounts found");
        const emptyPortfolio: WalletPortfolio = {
          totalUsd: "0",
          totalSol: "0",
          items: [],
        };
        await this.runtime.setCache<WalletPortfolio>(
          SOLANA_WALLET_DATA_CACHE_KEY,
          emptyPortfolio,
        );
        this.lastUpdate = now;
        return emptyPortfolio;
      }

      // Get token metadata (symbols) using parseTokenAccounts
      const tokenMetadata = await this.parseTokenAccounts(accounts);

      const items: Item[] = accounts.map((acc: any) => {
        const mint = acc.account.data.parsed.info.mint;
        const metadata = tokenMetadata[mint];

        this.decimalsCache.set(
          mint,
          acc.account.data.parsed.info.tokenAmount.decimals,
        );

        return {
          name: (metadata && metadata.symbol) || "Unknown",
          address: mint,
          symbol: (metadata && metadata.symbol) || "Unknown",
          decimals: acc.account.data.parsed.info.tokenAmount.decimals,
          balance: acc.account.data.parsed.info.tokenAmount.amount,
          uiAmount:
            acc.account.data.parsed.info.tokenAmount.uiAmount.toString(),
          priceUsd: "0",
          valueUsd: "0",
          valueSol: "0",
        };
      });

      logger.log(`Fallback mode: Found ${items.length} tokens in wallet`);

      const portfolio: WalletPortfolio = {
        totalUsd: "0",
        totalSol: "0",
        items,
      };

      await this.runtime.setCache<WalletPortfolio>(
        SOLANA_WALLET_DATA_CACHE_KEY,
        portfolio,
      );
      this.lastUpdate = now;
      return portfolio;
    } catch (error) {
      logger.error(`Error updating wallet data: ${error}`);
      throw error;
    }
  }

  /**
   * Retrieves cached wallet portfolio data from the database adapter.
   * @returns A promise that resolves with the cached WalletPortfolio data if available, otherwise resolves with null.
   */
  public async getCachedData(): Promise<WalletPortfolio | null> {
    const cachedValue = await this.runtime.getCache<WalletPortfolio>(
      SOLANA_WALLET_DATA_CACHE_KEY,
    );
    if (cachedValue) {
      return cachedValue;
    }
    return null;
  }

  /**
   * Forces an update of the wallet data and returns the updated WalletPortfolio object.
   * @returns A promise that resolves with the updated WalletPortfolio object.
   */
  public async forceUpdate(): Promise<WalletPortfolio> {
    return await this.updateWalletData(true);
  }

  //
  // MARK: any wallet
  //

  /**
   * Creates a new Solana wallet by generating a keypair
   * @returns {Promise<{publicKey: string, privateKey: string}>} Object containing base58-encoded public and private keys
   */
  public async createWallet(): Promise<{
    publicKey: string;
    privateKey: string;
  }> {
    try {
      // Generate new keypair
      const newKeypair = Keypair.generate();

      // Convert to base58 strings for secure storage
      const publicKey = newKeypair.publicKey.toBase58();
      const privateKey = bs58.encode(newKeypair.secretKey);

      // Clear the keypair from memory
      newKeypair.secretKey.fill(0);

      return {
        publicKey,
        privateKey,
      };
    } catch (error) {
      logger.error(`Error creating wallet: ${error}`);
      throw new Error("Failed to create new wallet");
    }
  }

  /*
  for (const t of haveTokens) {
      const amountRaw = t.account.data.parsed.info.tokenAmount.amount;
      const ca = new PublicKey(t.account.data.parsed.info.mint);
      const decimals = t.account.data.parsed.info.tokenAmount.decimals;
      const balance = Number(amountRaw) / (10 ** decimals);
      const symbol = await solanaService.getTokenSymbol(ca);
*/
  public async getTokenAccountsByKeypair(
    walletAddress: PublicKey,
    options: { notOlderThan?: number; includeZeroBalances?: boolean } = {},
  ): Promise<KeyedParsedTokenAccount[]> {
    //console.log('getTokenAccountsByKeypair', walletAddress.toString())
    //console.log('publicKey', this.publicKey, 'vs', walletAddress)
    const key = `solana_${walletAddress.toString()}_tokens`;
    //console.trace('whos checking jj')
    try {
      const now = Date.now();
      let check = false;
      // default is undefined, which will run thecheck
      if ((options as any).notOlderThan !== 0) {
        check = await this.runtime.getCache<any>(key);
        if (check) {
          // how old is this data, do we care
          const diff = now - (check as any).fetchedAt;
          // 1s - 5min cache?
          // FIXME: options driven...
          const acceptableInMs: number = options.notOlderThan ?? 60_000; // default
          if (diff < acceptableInMs) {
            console.log(
              "getTokenAccountsByKeypair cache HIT, its",
              `${diff.toLocaleString()}ms old`,
            );
            return (check as any).data;
          }
          console.log(
            "getTokenAccountsByKeypair cache MISS, its",
            `${diff.toLocaleString()}ms old`,
          );
        }
      }
      console.log(
        "getTokenAccountsByKeypair - getParsedTokenAccountsByOwner",
        walletAddress.toString(),
      );

      const [accounts, token2022s]: [
        ParsedTokenAccountsResponse,
        ParsedTokenAccountsResponse,
      ] = await Promise.all([
        this.connection.getParsedTokenAccountsByOwner(walletAddress, {
          programId: TOKEN_PROGRAM_ID, // original SPL
        }),
        this.connection.getParsedTokenAccountsByOwner(walletAddress, {
          programId: TOKEN_2022_PROGRAM_ID, // Token 2022
        }),
      ]);
      //console.log('token2022s', token2022s)
      //const haveToken22s = token2022s.value.filter(account => account.account.data.parsed.info.tokenAmount.amount !== '0')
      //console.log('haveToken22s', haveToken22s)
      //for(const t of token2022s.value) { console.log('t2022 account.data', t.account.data) }
      //const haveTokens = accounts.value.filter(account => account.account.data.parsed.info.tokenAmount.amount !== '0')
      const allTokens: KeyedParsedTokenAccount[] = [
        ...token2022s.value,
        ...accounts.value,
      ];

      // update decimalCache
      const haveAllTokens: KeyedParsedTokenAccount[] = [];
      for (const t of allTokens) {
        const { amount, decimals } = t.account.data.parsed.info.tokenAmount;
        this.decimalsCache.set(t.account.data.parsed.info.mint, decimals);
        // filter out zero balances (if not includeZeroBalances)
        if (options.includeZeroBalances || amount !== "0") {
          haveAllTokens.push(t);
        }
      }

      // do we have old data
      if (check) {
        // should we compare haveTokens with the old data we have
        // and generate events?
      }
      await this.runtime.setCache<any>(key, {
        fetchedAt: now,
        data: haveAllTokens,
      });
      return haveAllTokens;
    } catch (error) {
      logger.error(`Error fetching token accounts: ${error}`);
      return [];
    }
  }

  public async getTokenAccountsByKeypairs(
    walletAddresses: string[],
    options = {},
  ): Promise<Record<string, KeyedParsedTokenAccount[]>> {
    const res = await Promise.all(
      walletAddresses.map((a) =>
        this.getTokenAccountsByKeypair(new PublicKey(a), options),
      ),
    );
    const out: Record<string, KeyedParsedTokenAccount[]> = {};
    for (let i = 0; i < walletAddresses.length; i++) {
      const addr = walletAddresses[i];
      const result = res[i];
      if (addr !== undefined && result !== undefined) {
        out[addr] = result;
      }
    }
    return out;
  }

  // deprecated
  /*
  public async getBalanceByAddr(walletAddressStr: string): Promise<number> {
    try {
      const publicKey = new PublicKey(walletAddressStr)
      console.log('getBalanceByAddr - getBalance')
      const lamports = await this.connection.getBalance(publicKey);
      return lamports * SolanaService.LAMPORTS2SOL
    } catch (error) {
      this.runtime.logger.error('solSrv:getBalanceByAddr - Error fetching wallet balance:', error);
      return -1;
    }
  }
  */

  // only get SOL balance
  public async getBalancesByAddrs(
    walletAddressArr: string[],
  ): Promise<Record<string, number>> {
    try {
      //console.log('walletAddressArr', walletAddressArr)
      const publicKeyObjs = walletAddressArr.map((k) => new PublicKey(k));
      //console.log('getBalancesByAddrs - getMultipleAccountsInfo')
      const accounts = await this.batchGetMultipleAccountsInfo(
        publicKeyObjs,
        "getBalancesByAddrs",
      );

      //console.log('getBalancesByAddrs - accounts', accounts)
      const out: Record<string, number> = {};
      for (let i = 0; i < accounts.length; i++) {
        const a = accounts[i];
        // lamports, data, owner, executable, rentEpoch, space
        //console.log('a', a)
        const pk = walletAddressArr[i];
        if (pk === undefined) continue;
        if (a && a.lamports) {
          out[pk] = a.lamports * SolanaService.LAMPORTS2SOL;
        } else {
          console.log("no lamports? a", a);
          // null means there is no balance or the account is closed
          out[pk] = 0;
        }
      }
      return out;
    } catch (error) {
      const msg = (error as any).message || "";
      if (msg.includes("429")) {
        this.runtime.logger.warn("RPC rate limit hit, pausing before retry");
        // FIXME: retry counter, exponential backoff
        await new Promise((waitResolve) => setTimeout(waitResolve, 1000));
        return this.getBalancesByAddrs(walletAddressArr);
      }
      //this.runtime.logger.error('solSrv:getBalancesByAddrs - Error fetching wallet balances:', error);
      this.runtime.logger.error(
        `solSrv:getBalancesByAddrs - unexpected error: ${error}`,
      );
      return {};
    }
  }

  // we might want USD price and other info...
  async walletAddressToHumanString(pubKey: string): Promise<string> {
    let balanceStr = "";
    // get wallet contents
    const pubKeyObj = new PublicKey(pubKey);

    const [balances, heldTokens] = await Promise.all([
      this.getBalancesByAddrs([pubKey]),
      this.getTokenAccountsByKeypair(pubKeyObj),
    ]);
    const solBal = balances[pubKey];

    balanceStr += `Wallet Address: ${pubKey}\n`;
    balanceStr += "  Token Address (Symbol)\n";
    balanceStr += `  So11111111111111111111111111111111111111111 ($sol) balance: ${solBal ?? "unknown"}\n`;
    const tokens = await this.parseTokenAccounts(heldTokens); // options
    for (const ca in tokens) {
      const t = tokens[ca];
      balanceStr += `  ${ca} ($${t.symbol}) balance: ${t.balanceUi}\n`;
    }
    balanceStr += "\n";
    return balanceStr;
  }

  async walletAddressToLLMString(pubKey: string): Promise<string> {
    let balanceStr = "";
    // get wallet contents
    const pubKeyObj = new PublicKey(pubKey);
    const [balances, heldTokens] = await Promise.all([
      this.getBalancesByAddrs([pubKey]),
      this.getTokenAccountsByKeypair(pubKeyObj),
    ]);
    //console.log('balances', balances)
    const solBal = balances[pubKey];
    balanceStr += `Wallet Address: ${pubKey}\n`;
    balanceStr += "Current wallet contents in csv format:\n";
    balanceStr += "Token Address,Symbol,Balance\n";
    balanceStr += `So11111111111111111111111111111111111111111,sol,${solBal ?? "unknown"}\n`;
    const tokens = await this.parseTokenAccounts(heldTokens); // options
    for (const ca in tokens) {
      const t = tokens[ca];
      balanceStr += `${ca},${t.symbol},${t.balanceUi}\n`;
    }
    balanceStr += "\n";
    return balanceStr;
  }

  //
  // MARK: wallet Associated Token Account (ATA)
  //

  // single wallet, list of tokens
  public async getWalletBalances(
    publicKeyStr: string,
    mintAddresses: string[],
  ): Promise<Record<string, MintBalance | null>> {
    const owner = new PublicKey(publicKeyStr);
    const mints = mintAddresses.map((m) => new PublicKey(m));

    // 1) Derive ATAs for both programs
    const ataPairs = mints.map((mint) => {
      const ataLegacy = getAssociatedTokenAddressSync(
        mint,
        owner,
        false,
        TOKEN_PROGRAM_ID,
      );
      const ata2022 = getAssociatedTokenAddressSync(
        mint,
        owner,
        false,
        TOKEN_2022_PROGRAM_ID,
      );
      return { mint, ataLegacy, ata2022 };
    });

    // 2) Batch fetch token accounts (both program ATAs)
    const allAtaAddrs = ataPairs.flatMap((p) => [p.ataLegacy, p.ata2022]);
    const ataInfos = await this.batchGetMultipleAccountsInfo(
      allAtaAddrs,
      "getWalletBalances",
    );

    // 3) Batch fetch mint accounts (for decimals)
    //const mintInfos = await getMultiple(connection, mints, opts?.commitment);
    const mintInfos = await this.batchGetMultipleAccountsInfo(
      mints,
      "getWalletBalances",
    );

    // 4) Build quick lookups
    const mintDecimals = new Map<string, number>();
    mints.forEach((mintPk, i) => {
      const acc = mintInfos[i];
      if (!acc) return;
      // MintLayout.decode expects acc.data to be a Buffer of correct length
      const mintData = MintLayout.decode(acc.data);
      mintDecimals.set(mintPk.toBase58(), mintData.decimals);
    });

    const byAddress = new Map<
      string,
      ReturnType<typeof AccountLayout.decode> | null
    >();
    allAtaAddrs.forEach((ata, i) => {
      const info = ataInfos[i];
      if (!info) {
        byAddress.set(ata.toBase58(), null);
        return;
      }
      byAddress.set(ata.toBase58(), AccountLayout.decode(info.data));
    });

    // 5) Assemble balances; prefer legacy program over 2022 if both exist
    const out: Record<string, MintBalance | null> = {};

    for (const { mint, ataLegacy, ata2022 } of ataPairs) {
      const mintStr = mint.toBase58();
      const decimals = mintDecimals.get(mintStr);
      // If we don’t know decimals (mint account not found), we can’t compute uiAmount
      if (decimals === undefined) {
        out[mintStr] = null;
        continue;
      }

      const legacy = byAddress.get(ataLegacy.toBase58());
      const tok2022 = byAddress.get(ata2022.toBase58());

      // Choose which token account to use:
      const chosen = legacy ?? tok2022;
      if (!chosen) {
        out[mintStr] = null; // ATA doesn’t exist → zero balance
        continue;
      }

      // AccountLayout amount is a u64 in little-endian buffer
      const rawAmount = BigInt(chosen.amount.toString()); // AccountLayout already gives a BN-like
      const amountStr = rawAmount.toString();
      const uiAmount = Number(rawAmount) / 10 ** decimals;

      out[mintStr] = { amount: amountStr, decimals, uiAmount };
    }

    return out;
  }

  // 5 calls to get a balance for 500 wallets
  public async getTokenBalanceForWallets(
    mint: PublicKey,
    walletAddresses: string[],
  ): Promise<Record<string, number>> {
    const walletPubkeys = walletAddresses.map((a) => new PublicKey(a));
    const atAs = walletPubkeys.map((w) =>
      getAssociatedTokenAddressSync(mint, w),
    );
    const balances: Record<string, number> = {};

    // fetch mint decimals once
    const decimals = await this.getDecimal(mint);

    // fetch ATAs in batches
    const infos = await this.batchGetMultipleAccountsInfo(
      atAs,
      "getTokenBalanceForWallets",
    );

    infos.forEach((info, idx) => {
      const walletPubkey = walletPubkeys[idx];
      const ata = atAs[idx];
      if (walletPubkey === undefined || ata === undefined) {
        return; // skip if any is undefined
      }
      const walletKey = walletPubkey.toBase58();
      let uiAmount = 0;

      const infoData = info && info.data;
      if (infoData) {
        const account = unpackAccount(ata, info);
        // address, mint, owner, amount, delegate, delegatedAmount, isInitiailized, isFrozen, isNative
        // rentExemptReserve, closeAuthority, tlvData
        const raw = account.amount; // bigint
        uiAmount = Number(raw) / 10 ** decimals;
      }

      balances[walletKey] = uiAmount;
    });

    return balances;
  }

  /**
   * Subscribes to account changes for the given public key
   * @param {string} accountAddress - The account address to subscribe to
   * @returns {Promise<number>} Subscription ID
   */
  // needs to take a handler...
  public async subscribeToAccount(
    accountAddress: string,
    handler: any,
  ): Promise<number> {
    try {
      if (!this.validateAddress(accountAddress)) {
        throw new Error("Invalid account address");
      }

      // Check if already subscribed
      if (this.subscriptions.has(accountAddress)) {
        return this.subscriptions.get(accountAddress)!;
      }

      /*
      // Create WebSocket connection if needed
      const ws = (this.connection as any).connection._rpcWebSocket;

      const subscriptionId = await ws.call('accountSubscribe', [
        accountAddress,
        {
          encoding: 'jsonParsed',
          commitment: 'finalized',
        },
      ]);

      // Setup notification handler
      ws.subscribe(subscriptionId, 'accountNotification', async (notification: any) => {
        try {
          const { result } = notification;
          const resultValue = result && result.value;
          if (resultValue) {
            // Force update wallet data to reflect changes
            await this.updateWalletData(true);

            // Emit an event that can be handled by the agent
            this.runtime.emit('solana:account:update', {
              address: accountAddress,
              data: result.value,
            });
          }
        } catch (error) {
          logger.error('Error handling account notification:', error);
        }
      });
      */
      const accountPubkeyObj = new PublicKey(accountAddress);
      const subscriptionId = this.connection.onAccountChange(
        accountPubkeyObj,
        (accountInfo, context) => {
          handler(accountAddress, accountInfo, context);
        },
        "finalized",
      );

      this.subscriptions.set(accountAddress, subscriptionId);
      logger.log(
        `Subscribed to account ${accountAddress} with ID ${subscriptionId}`,
      );
      return subscriptionId;
    } catch (error) {
      logger.error(`Error subscribing to account: ${error}`);
      throw error;
    }
  }

  /**
   * Unsubscribes from account changes
   * @param {string} accountAddress - The account address to unsubscribe from
   * @returns {Promise<boolean>} Success status
   */
  public async unsubscribeFromAccount(
    accountAddress: string,
  ): Promise<boolean> {
    try {
      const subscriptionId = this.subscriptions.get(accountAddress);
      if (!subscriptionId) {
        logger.warn(`No subscription found for account ${accountAddress}`);
        return false;
      }

      await this.connection.removeAccountChangeListener(subscriptionId);
      this.subscriptions.delete(accountAddress);

      return true;
    } catch (error) {
      logger.error(`Error unsubscribing from account: ${error}`);
      throw error;
    }
  }

  /**
   * Calculates the optimal buy amount and slippage based on market conditions
   * @param {string} inputMint - Input token mint address
   * @param {string} outputMint - Output token mint address
   * @param {number} availableAmount - Available amount to trade
   * @returns {Promise<{ amount: number; slippage: number }>} Optimal amount and slippage
   */
  public async calculateOptimalBuyAmount(
    inputMint: string,
    outputMint: string,
    availableAmount: number,
  ): Promise<{ amount: number; slippage: number }> {
    try {
      // Get price impact for the trade

      // quote.priceImpactPct
      const priceImpact = await this.jupiterService.getPriceImpact({
        inputMint,
        outputMint,
        amount: availableAmount,
      });

      // Find optimal slippage based on market conditions
      const slippage = await this.jupiterService.findBestSlippage({
        inputMint,
        outputMint,
        amount: availableAmount,
      });

      // FIXME: would be good to know how much volume in the last hour...

      //console.log('calculateOptimalBuyAmount - optimal slippage', slippage)

      // If price impact is too high, reduce the amount
      let optimalAmount = availableAmount;
      if (priceImpact > 5) {
        // 5% price impact threshold
        optimalAmount = availableAmount * 0.5; // Reduce amount by half
        console.log(
          "calculateOptimalBuyAmount - too much price impact halving",
          optimalAmount,
        );
      }

      return { amount: optimalAmount, slippage };
    } catch (error) {
      logger.error(`Error calculating optimal buy amount: ${error}`);
      throw error;
    }
  }

  public async calculateOptimalBuyAmount2(
    quote: any,
    availableAmount: number,
  ): Promise<{ amount: number; slippage: number }> {
    try {
      // Get price impact for the trade

      // quote.priceImpactPct
      const priceImpact = Number(quote.priceImpactPct);

      // If price impact is too high, reduce the amount
      let optimalAmount = availableAmount;
      if (priceImpact > 5) {
        // 5% price impact threshold
        optimalAmount = availableAmount * 0.5; // Reduce amount by half
        console.log(
          "calculateOptimalBuyAmount2 - too much price impact halving",
          optimalAmount,
        );
      }

      let recommendedSlippage: number;
      if (priceImpact < 0.5) {
        recommendedSlippage = 50; // 0.5%
      } else if (priceImpact < 1) {
        recommendedSlippage = 100; // 1%
      } else {
        recommendedSlippage = 200; // 2%
      }

      //console.log('calculateOptimalBuyAmount - optimal slippage', slippage)
      return { amount: optimalAmount, slippage: recommendedSlippage };
    } catch (error) {
      logger.error(
        `calculateOptimalBuyAmount2 - Error calculating optimal buy amount: ${error}`,
      );
      throw error;
    }
  }

  /**
   * Executes buy/sell orders for multiple wallets
   * @param {Array<{ keypair: any; amount: number }>} wallets - Array of buy information
   * @param {any} signal - Trading signal information
   * @returns {Promise<Array<{ success: boolean; outAmount?: number; fees?: any; swapResponse?: any }>>}
   */
  public async executeSwap(
    wallets: Array<{ keypair: any; amount: number }>,
    signal: any,
  ): Promise<Record<string, unknown>> {
    // do it in serial to avoid hitting rate limits
    const swapResponses = {};
    for (const wallet of wallets) {
      const pubKey = wallet.keypair.publicKey.toString();
      try {
        // validate amount
        const intAmount: number = parseInt(wallet.amount.toString(), 10);
        if (Number.isNaN(intAmount) || intAmount <= 0) {
          console.warn(
            `solana::executeSwap - Amount in ${wallet.amount} become ${intAmount}`,
          );
          (swapResponses as any)[pubKey] = {
            success: false,
            error: "bad amount",
          };
          continue;
        }

        // FIXME: pass in balance to avoid this check

        // balance check to protect quote rate limit
        const balances = await this.getBalancesByAddrs([pubKey]);
        const bal = balances[pubKey] ?? 0;
        //console.log('executeSwap -', wallet.keypair.publicKey, 'bal', bal)

        // 0.000748928
        // might need to be 0.004

        const baseLamports = this.jupiterService.estimateLamportsNeeded({
          inputMint: signal.sourceTokenCA,
          inAmount: intAmount,
        });
        const ourLamports = bal * 1e9;
        //console.log('baseLamports', baseLamports.toLocaleString(), 'weHave', ourLamports.toLocaleString())
        // avoid wasting jupiter quote rate limit
        if (baseLamports > ourLamports) {
          console.log(
            `executeSwap - wallet ${wallet.keypair.publicKey} SOL is too low to swap baseLamports ${baseLamports.toLocaleString()} weHave ${ourLamports.toLocaleString()}`,
          );
          (swapResponses as any)[pubKey] = {
            success: false,
            error: "not enough SOL",
          };
          continue;
        }

        /*
        if (bal < 0.001) {
          console.log('executeSwap - wallet', wallet.keypair.publicKey, 'SOL is too low to do anything', bal)
          swapResponses[pubKey] = {
            success: false,
            error: 'not enough SOL'
          };
          continue
        }
        */

        console.log(
          "signal.sourceTokenCA",
          signal.sourceTokenCA,
          "signal.targetTokenCA",
          signal.targetTokenCA,
          "wallet.amount",
          wallet.amount.toLocaleString(),
        );

        // is this reusable if there's a bunch of wallets with the same amount

        // Get initial quote to determine input mint and other parameters
        const initialQuote = await this.jupiterService.getQuote({
          inputMint: signal.sourceTokenCA,
          outputMint: signal.targetTokenCA,
          slippageBps: 200,
          amount: intAmount, // in atomic units of the token
        });
        // no decimals
        console.log("initialQuote", initialQuote);
        // a percentage over the requested...
        if (initialQuote.totalLamportsNeeded > baseLamports) {
          console.log(
            "initialQuote fee over estimate: ",
            baseLamports.toLocaleString(),
          );
          console.log("routes", initialQuote.routePlan);
        }

        const availableLamports = bal * 1e9;
        //console.log('availableLamports', availableLamports.toLocaleString())
        if (initialQuote.totalLamportsNeeded > availableLamports) {
          // we can't afford as is
          console.log(
            `executeSwap - wallet ${wallet.keypair.publicKey} SOL is too low, has ${availableLamports.toLocaleString()} needs ${initialQuote.totalLamportsNeeded.toLocaleString()}`,
          );
          // lets make sure
          (swapResponses as any)[pubKey] = {
            success: false,
            error: "not enough SOL",
          };
          continue;
        }

        /*
        const fees = {
          lamports: initialQuote.otherAmountThreshold,
          sol: initialQuote.otherAmountThreshold * SolanaService.LAMPORTS2SOL
        }
        */

        // outAmount, minOutAmount, priceImpactPct
        const impliedSlippageBps: number =
          ((initialQuote.outAmount - initialQuote.otherAmountThreshold) /
            initialQuote.outAmount) *
          10_000;
        console.log(
          "impliedSlippageBps",
          impliedSlippageBps,
          "jupSlip",
          initialQuote.slippageBps,
        );

        // Calculate optimal buy amount using the input mint from quote
        // slippage is drived by price impact
        const { amount, slippage } = await this.calculateOptimalBuyAmount2(
          initialQuote,
          wallet.amount,
        );
        /*
        const { amount, slippage } = await this.calculateOptimalBuyAmount(
          initialQuote.inputMint,
          initialQuote.outputMint,
          wallet.amount
        );
        */
        // amount is in atomic units (input token)
        //
        console.log(
          "adjusted amount",
          Number(`${amount}`).toLocaleString(),
          "price impact slippage",
          slippage,
        );
        // adjust amount in initialQuote
        initialQuote.inAmount = `${amount}`; // in input atomic units
        delete initialQuote.swapUsdValue; // invalidate

        /*
        // Get final quote with optimized amount
        const quoteResponse = await this.jupiterService.getQuote({
          inputMint: initialQuote.inputMint,
          outputMint: initialQuote.outputMint,
          amount,
          slippageBps: slippage,
        });
        console.log('quoteResponse', quoteResponse)
        const fees = {
          lamports: quoteResponse.otherAmountThreshold,
          sol: quoteResponse.otherAmountThreshold * SolanaService.LAMPORTS2SOL
        }
        */

        // why were we doing this?
        // partially to understand but we have docs now: https://dev.jup.ag/docs/api/swap-api/swap
        /*
        const quoteResponse = {
          inputMint: initialQuote.inputMint,
          inAmount: initialQuote.inAmount,
          outputMint: initialQuote.outputMint,
          outAmount: initialQuote.outAmount,
          otherAmountThreshold: initialQuote.otherAmountThreshold, // minimum amount after slippage
          swapMode: initialQuote.swapMode,
          slippageBps: initialQuote.slippageBps,
          platformFee: initialQuote.platformFee,
          priceImpactPct: initialQuote.priceImpactPct,
          routePlan: initialQuote.routePlan,
          contextSlot: initialQuote.contextSlot,
          timeTaken: initialQuote.timeTaken,
        }
        */

        // Execute the swap
        let swapResponse;
        const executeSwap = async (impliedSlippageBps: number) => {
          console.log(
            "executingSwap",
            pubKey,
            signal.sourceTokenCA,
            signal.targetTokenCA,
            "with",
            `${impliedSlippageBps}bps slippage`,
          );
          // convert quote into instructions
          swapResponse = await this.jupiterService.executeSwap({
            quoteResponse: initialQuote,
            userPublicKey: pubKey,
            slippageBps: parseInt(impliedSlippageBps.toString(), 10),
          });
          //console.log('swapResponse', swapResponse)
          //console.log('keypair', wallet.keypair)

          const secretKey = bs58.decode(wallet.keypair.privateKey as string);
          const keypair = Keypair.fromSecretKey(secretKey);
          //const signature = await this.executeSwap(keypair, swapResponse)
          //console.log('keypair', keypair)

          // Deserialize, sign, and send
          const txBuffer = Buffer.from(
            swapResponse.swapTransaction as string,
            "base64",
          );
          const transaction = VersionedTransaction.deserialize(
            Uint8Array.from(txBuffer),
          );
          transaction.sign([keypair]);
          //transaction.sign(...keypairs); not [keypairs]

          // Getting recent blockhash too slow for Solana/Jupiter
          /*
          const { blockhash } = await this.connection.getLatestBlockhash('finalized');
          console.log('blockhash', blockhash)
          transaction.message.recentBlockhash = blockhash;
          */

          /*
          // just verify the quote is matching up
          const inner = transaction.meta.innerInstructions || [];
          let totalReceived = 0;
          inner.forEach(({ instructions }) => {
            instructions.forEach((ix: any) => {
              if (ix.program === 'spl-token' && ix.parsed.type === 'transfer') {
                const info = ix.parsed.info;
                if (info.destination === YOUR_TOKEN_ACCOUNT) {
                  totalReceived += Number(info.amount) / (10 ** DECIMALS);
                }
              }
            });
          });
          */

          // Send and confirm
          let txid = "";
          try {
            txid = await this.connection.sendRawTransaction(
              transaction.serialize(),
            );
          } catch (err) {
            if (err instanceof SendTransactionError) {
              // getLogs expects param?
              const logs = err.logs || (await err.getLogs(this.connection));

              let showLogs = true;

              if (logs) {
                if (
                  logs.some((l) => l.includes("custom program error: 0x1771"))
                ) {
                  console.log(
                    `Swap failed: slippage tolerance exceeded. ${impliedSlippageBps}`,
                  );
                  // handle slippage
                  // 🎯 You could retry with higher slippage or log for the user

                  // increment the slippage? and try again?
                  if (
                    signal.targetTokenCA ===
                    "So11111111111111111111111111111111111111112"
                  ) {
                    // sell parameters
                    if (impliedSlippageBps < 3000) {
                      // let jupiter swap api rest
                      await new Promise((resolve) => setTimeout(resolve, 1000));
                      // double and try again
                      return executeSwap(impliedSlippageBps * 2);
                    }
                    // just fail
                  } else {
                    // buy parameters
                    // we don't need to pay more
                    // but we can retry
                    showLogs = false;
                  }
                }

                if (logs.some((l) => l.includes("insufficient lamports"))) {
                  console.log(
                    "Transaction failed: insufficient lamports in the account.",
                  );
                  // optionally prompt user to top up SOL
                }

                if (
                  logs.some((l) =>
                    l.includes("Program X failed: custom program error"),
                  )
                ) {
                  console.log("Custom program failure detected.");
                  // further custom program handling
                }

                if (showLogs) {
                  console.log("logs", logs);
                }
              }
            }
            throw err;
          }
          console.log(
            pubKey,
            signal.sourceTokenCA,
            signal.targetTokenCA,
            "txid",
            txid,
          ); // should probably always log this
          // swapResponse is of value
          return txid;
        };

        const txid = await executeSwap(impliedSlippageBps);

        // only adding this back to slow down quoting
        await this.connection.confirmTransaction(txid, "finalized");
        //console.log('finalized')

        // Get transaction details including fees
        const txDetails = await this.connection.getTransaction(txid, {
          commitment: "confirmed",
          maxSupportedTransactionVersion: 0,
        });
        //console.log('txDetails', txDetails)

        //const JUPITER_AGGREGATOR_V6 = new PublicKey("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");
        /*
        const swapIxIndex = txDetails.transaction.message.instructions
          .findIndex(ix => txDetails.transaction.message.accountKeys[ix.programIdIndex] === "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");
        */
        /*
        const swapIxIndex = txDetails.transaction.message.instructions.findIndex(ix =>
          txDetails.transaction.message.accountKeys[ix.programIdIndex].equals(JUPITER_AGGREGATOR_V6)
        );

        const txDetailsMeta = txDetails && txDetails.meta;
        const innerInstructions = txDetailsMeta && txDetailsMeta.innerInstructions;
        const inner = innerInstructions && innerInstructions.find(i => i.index === swapIxIndex);
        let totalReceivedRaw = 0;

        if (inner && inner.instructions) {
          inner.instructions.forEach(ix => {
            if (ix.program === 'spl-token' && ix.parsed.type === 'transfer') {
              const info = ix.parsed.info;
              if (info.destination === YOUR_TOKEN_ACCOUNT) {
                totalReceivedRaw += Number(info.amount);
              }
            }
          });
        const decimals = DECIMALS; // fetch or store elsewhere
        const totalReceived = totalReceivedRaw / (10 ** decimals);
        console.log('Total tokens received:', totalReceived);
        */
        let outAmount = initialQuote.outAmount;
        console.log("going to report", initialQuote.outAmount);
        //console.log('postTokenBalances', txDetails.meta.postTokenBalances)

        const txDetailsMeta = txDetails && txDetails.meta;
        const preTokenBalances = txDetailsMeta && txDetailsMeta.preTokenBalances;
        const postTokenBalances = txDetailsMeta && txDetailsMeta.postTokenBalances;
        if (preTokenBalances && postTokenBalances) {
          // if selling
          const tokenCA = signal.targetTokenCA;

          // probably shouldn't flip it because
          // outBal becomes the sell amount, so the labels are just wrong
          // we only care about the targetCAamount
          // if it's not flipped is it not found?
          /*
          if (signal.targetTokenCA === 'So11111111111111111111111111111111111111112') {
            tokenCA = signal.sourceTokenCA
          }
          */

          // find only returns the first match
          const inBal = preTokenBalances.find(
            (tb) => tb.owner === pubKey && tb.mint === tokenCA,
          );
          const outBal = postTokenBalances.find(
            (tb) => tb.owner === pubKey && tb.mint === tokenCA,
          );
          const inBalUiTokenAmount = inBal && inBal.uiTokenAmount;
          const outBalUiTokenAmount = outBal && outBal.uiTokenAmount;
          console.log(
            "inBal",
            inBalUiTokenAmount && inBalUiTokenAmount.uiAmount,
            "outBal",
            outBalUiTokenAmount && outBalUiTokenAmount.uiAmount,
          );

          // if selling to SOL, there won't be an account change

          if (outBalUiTokenAmount && outBalUiTokenAmount.decimals) {
            this.decimalsCache.set(tokenCA, outBalUiTokenAmount.decimals);
          }

          if (
            signal.targetTokenCA ===
            "So11111111111111111111111111111111111111112"
          ) {
            // swap to SOL

            // outAmount is how much sol we're getting...
            console.log(
              "selling, how much sol we getting from meta",
              pubKey,
              postTokenBalances,
            );
            // So11111111111111111111111111111111111111112 in in amounts tbh
            // feel like inBal/outBal is still off/wrong here...

            if (inBal && outBal) {
              // in will be high than out in this scenario?
              const lamDiff =
                (inBal.uiTokenAmount.uiAmount ?? 0) -
                (outBal.uiTokenAmount.uiAmount ?? 0);
              const diff =
                Number(inBal.uiTokenAmount.amount ?? 0) -
                Number(outBal.uiTokenAmount.amount ?? 0);
              // we definitely didn't swap for nothing
              if (diff) {
                outAmount = diff;
                console.log("changing report to", outAmount, "(", lamDiff, ")");
              }
            } else if (outBal) {
              // just means we weren't already holding the token
              const amt = Number(outBal.uiTokenAmount.amount);
              // we definitely didn't swap for nothing
              if (amt) {
                outAmount = amt;
                console.log("changing report to", outAmount);
              }
            } else {
              console.log("no balances? wallet", pubKey, "token", tokenCA);
              //console.log('preTokenBalances', preTokenBalances, '=>', postTokenBalances)
              console.log(
                "wallet",
                preTokenBalances.find(
                  (tb) => tb.owner === pubKey,
                ),
                "=>",
                postTokenBalances.find(
                  (tb) => tb.owner === pubKey,
                ),
              );
            }
          } else {
            if (inBal && outBal) {
              const lamDiff =
                (outBal.uiTokenAmount.uiAmount ?? 0) -
                (inBal.uiTokenAmount.uiAmount ?? 0);
              const diff =
                Number(outBal.uiTokenAmount.amount ?? 0) -
                Number(inBal.uiTokenAmount.amount ?? 0);
              // we definitely didn't swap for nothing
              if (diff) {
                outAmount = diff;
                console.log("changing report to", outAmount, "(", lamDiff, ")");
              }
            } else if (outBal) {
              // just means we weren't already holding the token
              const amt = Number(outBal.uiTokenAmount.amount);
              // we definitely didn't swap for nothing
              if (amt) {
                outAmount = amt;
                console.log("changing report to", outAmount);
              }
            } else {
              console.log("no balances? wallet", pubKey, "token", tokenCA);
              //console.log('preTokenBalances', txDetails.meta.preTokenBalances, '=>', txDetails.meta.postTokenBalances)
              console.log(
                "wallet",
                (txDetailsMeta && preTokenBalances && preTokenBalances.find(
                  (tb) => tb.owner === pubKey,
                )) || undefined,
                "=>",
                (txDetailsMeta && postTokenBalances && postTokenBalances.find(
                  (tb) => tb.owner === pubKey,
                )) || undefined,
              );
            }
          }
        }

        const fee = txDetailsMeta && txDetailsMeta.fee;
        const feeToLocaleString = fee && fee.toLocaleString;
        console.log(`Transaction fee: ${feeToLocaleString ? feeToLocaleString() : fee} lamports`);
        const fees = {
          /*
          quote: {
            lamports: initialQuote.platformFee.amount,
            bps: initialQuote.platformFee.feeBps,
          },
          */
          lamports: fee,
          sol: fee ? fee * SolanaService.LAMPORTS2SOL : 0,
        };

        /*
        // Calculate final amounts including fees
        const fees = await this.jupiterService.estimateGasFees({
          inputMint: initialQuote.inputMint,
          outputMint: initialQuote.outputMint,
          amount,
        });
        */

        (swapResponses as any)[pubKey] = {
          success: true,
          outAmount,
          outDecimal: await this.getDecimal(
            new PublicKey(signal.targetTokenCA),
          ),
          signature: txid,
          fees,
          swapResponse,
        };
      } catch (error) {
        logger.error(`Error in swap execution: ${error}`);
        (swapResponses as any)[pubKey] = { success: false };
      }
    }

    return swapResponses;
  }

  /**
   * Starts the Solana service with the given agent runtime.
   *
   * @param {IAgentRuntime} runtime - The agent runtime to use for the Solana service.
   * @returns {Promise<SolanaService>} The initialized Solana service.
   */
  static async start(runtime: IAgentRuntime): Promise<Service> {
    runtime.logger.log(`SolanaService start for ${runtime.character.name}`);

    const solanaService = new SolanaService(runtime);
    return solanaService;
  }

  /**
   * Stops the Solana service.
   *
   * @param {IAgentRuntime} runtime - The agent runtime.
   * @returns {Promise<void>} - A promise that resolves once the Solana service has stopped.
   */
  static async stop(runtime: IAgentRuntime): Promise<void> {
    const client = runtime.getService(
      SOLANA_SERVICE_NAME,
    ) as SolanaService | null;
    if (!client) {
      runtime.logger.error("SolanaService not found during static stop");
      return;
    }
    await client.stop();
  }

  /**
   * Cleans up subscriptions
   * @returns {Promise<void>} A Promise that resolves when the update interval is stopped.
   */
  async stop(): Promise<void> {
    this.runtime.logger.info("SolanaService: Stopping instance...");
    // Unsubscribe from all accounts
    for (const [address] of this.subscriptions) {
      await this.unsubscribeFromAccount(address).catch((e) =>
        this.runtime.logger.error(
          `Error unsubscribing from ${address} during stop:`,
          e instanceof Error ? e.message : String(e),
        ),
      );
    }
    this.subscriptions.clear();
  }
}
