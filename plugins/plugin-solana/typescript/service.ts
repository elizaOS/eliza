import {
  type IAgentRuntime,
  logger,
  Service,
  ServiceType,
  type ServiceTypeName,
} from "@elizaos/core";

interface WalletAsset {
  address: string;
  symbol: string;
  balance: string;
  decimals: number;
  valueUsd: number;
}

interface WalletPortfolioType {
  totalValueUsd: number;
  assets: WalletAsset[];
}

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
import { unpack as unpackToken2022Metadata } from "@solana/spl-token-metadata";
import {
  type AccountInfo,
  Connection,
  type Context,
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
import type {
  BirdeyePriceResponse,
  BirdeyeWalletTokenListResponse,
  CacheWrapper,
  ExchangeProvider,
  ExtendedJupiterServiceInterface,
  Item,
  JupiterQuote,
  JupiterSwapResult,
  Prices,
  SwapExecutionResponse,
  SwapQuoteParams,
  SwapWalletEntry,
  TokenAccountEntry,
  TokenMetaCacheEntry,
  TradingSignal,
  WalletPortfolio,
} from "./types";

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

type ParsedTokenAccountsResponse = Awaited<ReturnType<Connection["getParsedTokenAccountsByOwner"]>>;

const METADATA_PROGRAM_ID = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");

export interface ISolanaPluginServiceAPI extends Service {
  executeSwap: (
    wallets: Array<{ keypair: Keypair; amount: number }>,
    signal: TradingSignal
  ) => Promise<Record<string, SwapExecutionResponse>>;
  getPublicKey: () => PublicKey | null;
}

export class SolanaWalletService extends Service {
  static override readonly serviceType: string = ServiceType.WALLET;
  public readonly capabilityDescription =
    "Provides standardized access to Solana wallet balances and portfolios.";

  private _solanaService: SolanaService | null = null;

  constructor(runtime?: IAgentRuntime) {
    super(runtime);
    if (!runtime) throw new Error("runtime is required for SolanaWalletService");
  }

  private get solanaService(): SolanaService {
    if (!this._solanaService) {
      this._solanaService = this.runtime.getService("chain_solana") as SolanaService;
      if (!this._solanaService) {
        throw new Error("Solana Service is required for Solana Wallet Service");
      }
    }
    return this._solanaService;
  }

  public async getPortfolio(owner?: string): Promise<WalletPortfolioType> {
    const publicKey = await this.solanaService.getPublicKey();
    const publicKeyBase58 = publicKey?.toBase58();
    if (owner && publicKeyBase58 && owner !== publicKeyBase58) {
      throw new Error(
        `This SolanaService instance can only get the portfolio for its configured wallet: ${publicKeyBase58}`
      );
    }
    const wp: WalletPortfolio = await this.solanaService.updateWalletData(true);
    const out: WalletPortfolioType = {
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

  public async getBalance(assetAddress: string, owner?: string): Promise<number> {
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
      const balances = await this.solanaService.getBalancesByAddrs([ownerAddress]);
      const balance = balances[ownerAddress] ?? 0;
      return balance;
    }
    const tokensBalances: Record<string, KeyedParsedTokenAccount[]> =
      await this.solanaService.getTokenAccountsByKeypairs([ownerAddress]);
    const heldTokens = tokensBalances[ownerAddress] || [];
    for (const t of heldTokens) {
      if (t.account.data.parsed.info.mint === assetAddress) {
        return t.account.data.parsed.info.tokenAmount.uiAmount;
      }
    }
    this.runtime.logger.log("could not find", assetAddress, "in", heldTokens);
    return -1;
  }

  public async transferSol(from: Keypair, to: PublicKey, lamports: number): Promise<string> {
    try {
      const payerKey = await this.solanaService.getPublicKey();
      if (!payerKey) {
        throw new Error("SolanaService is not initialized with a fee payer key");
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

      const confirmation = await connection.confirmTransaction(signature, "confirmed");
      if (confirmation.value.err) {
        throw new Error(
          `Transaction confirmation failed: ${JSON.stringify(confirmation.value.err)}`
        );
      }

      return signature;
    } catch (error) {
      this.runtime.logger.error({ error }, "SolanaService: transferSol failed");
      throw error;
    }
  }

  static async start(runtime: IAgentRuntime): Promise<Service> {
    runtime.logger.log(`SolanaWalletService start for ${runtime.character.name}`);

    const solanaWalletService = new SolanaWalletService(runtime);
    return solanaWalletService;
  }

  static async stop(runtime: IAgentRuntime): Promise<void> {
    const client = runtime.getService(ServiceType.WALLET) as SolanaService | null;
    if (!client) {
      logger.error("SolanaWalletService not found during static stop");
      return;
    }
    await client.stop();
  }

  async stop(): Promise<void> {}
}

export class SolanaService extends Service {
  static override readonly serviceType: string = SOLANA_SERVICE_NAME;
  public readonly capabilityDescription =
    "The agent is able to interact with the Solana blockchain, and has access to the wallet data";

  private lastUpdate = 0;
  private readonly UPDATE_INTERVAL = 2 * 60_000;
  private connection: Connection;

  private _publicKey: PublicKey | null = null;
  private _keypair: Keypair | null = null;
  private _publicKeyPromise: Promise<PublicKey | null> | null = null;
  private _keypairPromise: Promise<Keypair | null> | null = null;

  private exchangeRegistry: Record<number, ExchangeProvider> = {};
  private subscriptions: Map<string, number> = new Map();

  jupiterService: ExtendedJupiterServiceInterface | null = null;

  static readonly LAMPORTS2SOL = 1 / LAMPORTS_PER_SOL;
  static readonly SOL2LAMPORTS = LAMPORTS_PER_SOL;

  private decimalsCache = new Map<string, number>([
    ["EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", 6], // USDC
    ["Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", 6], // USDT
    ["So11111111111111111111111111111111111111112", 9], // SOL
  ]);

  constructor(runtime?: IAgentRuntime) {
    if (!runtime) throw new Error("runtime is required for solana service");
    super(runtime);
    this.exchangeRegistry = {};
    const rpcUrl = runtime.getSetting("SOLANA_RPC_URL");
    const rpcUrlStr = typeof rpcUrl === "string" ? rpcUrl : PROVIDER_CONFIG.DEFAULT_RPC;
    this.connection = new Connection(rpcUrlStr);

    runtime.getServiceLoadPromise("JUPITER_SERVICE" as ServiceTypeName).then(async () => {
      const service = runtime.getService("JUPITER_SERVICE" as ServiceTypeName);
      if (this.isJupiterService(service)) {
        this.jupiterService = service;
      } else {
        this.jupiterService = null;
      }
    });
    this.subscriptions = new Map();
  }

  private isJupiterService(
    service: Service | null
  ): service is Service & ExtendedJupiterServiceInterface {
    if (service === null) return false;
    const maybeJupiter = service as {
      getQuote?: (params: SwapQuoteParams) => Promise<JupiterQuote>;
    };
    return typeof maybeJupiter.getQuote === "function";
  }

  private async ensurePublicKey(): Promise<PublicKey | null> {
    if (this._publicKey) return this._publicKey;
    if (this._publicKeyPromise) return this._publicKeyPromise;

    this._publicKeyPromise = (async () => {
      try {
        const result = await getWalletKey(this.runtime, false);
        if (!result.publicKey) return null;
        this._publicKey = result.publicKey;

        // Setup subscription
        await this.subscribeToAccount(this._publicKey.toBase58(), () => {
          this.updateWalletData().catch((err) =>
            this.runtime.logger.error({ err }, "Failed to update wallet data")
          );
        });

        await this.updateWalletData();
        return this._publicKey;
      } catch (error) {
        this.runtime.logger.error(
          "[Solana] Failed to load public key:",
          error instanceof Error ? error.message : String(error)
        );
        return null;
      } finally {
        this._publicKeyPromise = null;
      }
    })();

    return this._publicKeyPromise;
  }

  private async ensureKeypair(): Promise<Keypair | null> {
    if (this._keypair) return this._keypair;
    if (this._keypairPromise) return this._keypairPromise;

    this._keypairPromise = (async () => {
      try {
        const result = await getWalletKey(this.runtime, true);
        if (!result.keypair) return null;
        this._keypair = result.keypair;
        return this._keypair;
      } catch (error) {
        this.runtime.logger.error(
          "[Solana] Failed to load keypair:",
          error instanceof Error ? error.message : String(error)
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
    await this.ensurePublicKey();
  }

  public getConnection(): Connection {
    return this.connection;
  }

  async registerExchange(provider: ExchangeProvider) {
    const id = Object.values(this.exchangeRegistry).length + 1;
    this.runtime.logger.success(`Registered ${provider.name} as Solana provider #${id}`);
    this.exchangeRegistry[id] = provider;
    return id;
  }

  private async birdeyeFetchWithRetry(
    url: string,
    options: RequestInit = {}
  ): Promise<BirdeyeWalletTokenListResponse | BirdeyePriceResponse> {
    let lastError: Error | undefined;
    const fetchFn = this.runtime.fetch || globalThis.fetch;

    for (let i = 0; i < PROVIDER_CONFIG.MAX_RETRIES; i++) {
      try {
        const response = await fetchFn(url, {
          ...options,
          headers: {
            Accept: "application/json",
            "x-chain": "solana",
            "X-API-KEY": this.runtime.getSetting("BIRDEYE_API_KEY") as string,
            ...(options.headers || {}),
          },
        } as RequestInit);

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`HTTP error! status: ${response.status}, message: ${errorText}`);
        }

        return await response.json();
      } catch (error) {
        logger.error({ error }, `Attempt ${i + 1} failed`);
        lastError = error instanceof Error ? error : new Error(String(error));
        if (i < PROVIDER_CONFIG.MAX_RETRIES - 1) {
          await new Promise((resolve) => setTimeout(resolve, PROVIDER_CONFIG.RETRY_DELAY * 2 ** i));
        }
      }
    }

    throw (
      lastError ?? new Error(`Failed to fetch ${url} after ${PROVIDER_CONFIG.MAX_RETRIES} retries`)
    );
  }

  async batchGetMultipleAccountsInfo(
    pubkeys: PublicKey[],
    _label: string
  ): Promise<(AccountInfo<Buffer> | null)[]> {
    const results: (AccountInfo<Buffer> | null)[] = [];
    for (let i = 0; i < pubkeys.length; i += 100) {
      const slice = pubkeys.slice(i, i + 100);
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

  public validateAddress(address: string | undefined): boolean {
    if (!address) return false;
    try {
      if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) {
        this.runtime.logger.warn(`Invalid Solana address format: ${address}`);
        return false;
      }

      const pubKey = new PublicKey(address);
      return Boolean(pubKey.toBase58());
    } catch (error) {
      this.runtime.logger.error({ error }, `Address validation error: ${address}`);
      return false;
    }
  }

  private static readonly TOKEN_ACCOUNT_DATA_LENGTH = 165;
  private static readonly TOKEN_MINT_DATA_LENGTH = 82;

  async getAddressType(address: string): Promise<string> {
    const types = await this.getAddressesTypes([address]);
    const result = types[address];
    if (result === undefined) {
      throw new Error(`Address type not found for ${address}`);
    }
    return result;
  }

  async getAddressesTypes(addresses: string[]): Promise<Record<string, string>> {
    const pubkeys = addresses.map((a) => new PublicKey(a));
    const infos = await this.batchGetMultipleAccountsInfo(pubkeys, "getAddressesTypes");

    const resultList: string[] = addresses.map((_addr, i) => {
      const info = infos[i];
      if (!info) return "Account does not exist";
      const dataLength = info.data.length;
      if (dataLength === 0) return "Wallet";
      if (dataLength === SolanaService.TOKEN_ACCOUNT_DATA_LENGTH) return "Token Account";
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

  public detectPubkeysFromString(input: string, checkCurve = false): Array<string> {
    const results = new Set<string>();
    const regex = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g;
    let match: RegExpExecArray | null;
    match = regex.exec(input);
    while (match !== null) {
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
        // Invalid Base58
      }
      match = regex.exec(input);
    }

    return Array.from(results);
  }

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
    m = base58Regex.exec(input);
    while (m !== null) {
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
        // Invalid base58
      }
      m = base58Regex.exec(input);
    }

    m = hexRegex.exec(input);
    while (m !== null) {
      const s = m[0];
      const buf = Buffer.from(s, "hex");
      if (buf.length === 64) {
        results.push({ format: "hex", match: s, bytes: Uint8Array.from(buf) });
      }
    }

    return results;
  }

  async getCirculatingSupply(mint: string) {
    const accounts = await this.connection.getParsedProgramAccounts(TOKEN_PROGRAM_ID, {
      filters: [
        { dataSize: 165 }, // size of token account
        { memcmp: { offset: 0, bytes: mint } }, // filter by mint
      ],
    });

    const KNOWN_EXCLUDED_ACCOUNTS = ["MINT_AUTHORITY_WALLET", "TREASURY_WALLET", "BURN_ADDRESS"];

    let circulating = 0;
    for (const acc of accounts) {
      const data = acc.account.data as ParsedAccountData;
      const info = data.parsed.info as {
        owner: string;
        tokenAmount: { amount: string; decimals: number };
      };
      const owner = info.owner;

      if (owner === "11111111111111111111111111111111") continue;
      if (KNOWN_EXCLUDED_ACCOUNTS.includes(owner)) continue;

      const amount = Number(info.tokenAmount.amount);
      const decimals = info.tokenAmount.decimals;
      circulating += amount / 10 ** decimals;
    }

    return circulating;
  }

  async getCirculatingSupplies(mints: string[]) {
    return Promise.all(mints.map((m) => this.getCirculatingSupply(m)));
  }

  private async fetchPrices(): Promise<Prices> {
    const cacheKey = "prices_sol_btc_eth";
    const cachedValue = await this.runtime.getCache<Prices>(cacheKey);

    if (cachedValue) {
      return cachedValue;
    }
    const { SOL, BTC, ETH } = PROVIDER_CONFIG.TOKEN_ADDRESSES;
    const tokens = [SOL, BTC, ETH];
    const prices: Prices = {
      solana: { usd: "0" },
      bitcoin: { usd: "0" },
      ethereum: { usd: "0" },
    };

    for (const token of tokens) {
      const response = (await this.birdeyeFetchWithRetry(
        `${PROVIDER_CONFIG.BIRDEYE_API}/defi/price?address=${token}`
      )) as BirdeyePriceResponse;

      if (response.success && response.data?.value) {
        const price = response.data.value.toString();
        prices[token === SOL ? "solana" : token === BTC ? "bitcoin" : "ethereum"].usd = price;
      }
    }

    await this.runtime.setCache<Prices>(cacheKey, prices);
    return prices;
  }

  public async getDecimal(mintPublicKey: PublicKey): Promise<number> {
    try {
      const key = mintPublicKey.toString();
      if (this.decimalsCache.has(key)) {
        const cachedDecimals = this.decimalsCache.get(key);
        if (cachedDecimals !== undefined) return cachedDecimals;
      }

      const acc = await this.connection.getParsedAccountInfo(mintPublicKey);
      const accValue = acc.value;
      const owner = accValue?.owner ? accValue.owner.toString() : undefined;

      if (owner === TOKEN_PROGRAM_ID.toString()) {
        const mintInfo = await getMint(this.connection, mintPublicKey);
        this.decimalsCache.set(key, mintInfo.decimals);
        return mintInfo.decimals;
      } else if (owner === TOKEN_2022_PROGRAM_ID.toString()) {
        const mintInfo = await getMint(
          this.connection,
          mintPublicKey,
          undefined,
          TOKEN_2022_PROGRAM_ID
        );
        this.decimalsCache.set(key, mintInfo.decimals);
        return mintInfo.decimals;
      }
      this.runtime.logger.error(`Unknown owner type ${owner}`);
      return -1;
    } catch (error) {
      this.runtime.logger.error(`Failed to fetch token decimals: ${error}`);
      return -1;
    }
  }

  public async getDecimals(mints: string[]): Promise<number[]> {
    const mintPublicKeys = mints.map((a) => new PublicKey(a));
    return Promise.all(mintPublicKeys.map((a) => this.getDecimal(a)));
  }

  public async getMetadataAddress(mint: PublicKey): Promise<PublicKey> {
    const [metadataPDA] = await PublicKey.findProgramAddress(
      [Buffer.from("metadata"), METADATA_PROGRAM_ID.toBuffer(), mint.toBuffer()],
      METADATA_PROGRAM_ID
    );
    return metadataPDA;
  }

  public async getTokenSymbol(mint: PublicKey): Promise<string | null> {
    const metadataAddress = await this.getMetadataAddress(mint);
    const accountInfo = await this.connection.getAccountInfo(metadataAddress);

    if (!accountInfo || !accountInfo.data) return null;

    const data = accountInfo.data;
    let offset = 1 + 32 + 32;

    const nameLen = data.readUInt32LE(offset);
    offset += 4 + nameLen;

    const symbolLen = data.readUInt32LE(offset);
    offset += 4;

    const symbol = data
      .slice(offset, offset + symbolLen)
      .toString("utf8")
      .replace(/\0/g, "");
    return symbol;
  }

  private parseToken2022SymbolFromMintOrPtr = (
    mintData: Buffer
  ): { symbol: string | null; ptr?: PublicKey } => {
    const inline = getExtensionData(ExtensionType.TokenMetadata, mintData);
    if (inline) {
      try {
        const md = unpackToken2022Metadata(inline);
        const mdSymbol = md?.symbol;
        const symbol = mdSymbol ? mdSymbol.replace(/\0/g, "").trim() : null;
        return { symbol };
      } catch {
        // Fall through to pointer
      }
    }

    const ptrExtBuffer = getExtensionData(ExtensionType.MetadataPointer, mintData);
    if (ptrExtBuffer && ptrExtBuffer.length >= 64) {
      const metadataAddress = ptrExtBuffer.subarray(32, 64);
      return { symbol: null, ptr: new PublicKey(metadataAddress) };
    }

    return { symbol: null };
  };

  public async getTokensSymbols(mints: string[]): Promise<Record<string, string | null>> {
    const mintKeys: PublicKey[] = mints.map((k) => new PublicKey(k));

    const metadataAddresses: PublicKey[] = await Promise.all(
      mintKeys.map((mk) => this.getMetadataAddress(mk))
    );
    const accountInfos = await this.batchGetMultipleAccountsInfo(
      metadataAddresses,
      "getTokensSymbols/Metaplex"
    );

    const out: Record<string, string | null> = {};
    const needs2022: PublicKey[] = [];

    mintKeys.forEach((token, i) => {
      const accountInfo = accountInfos[i];

      if (!accountInfo || !accountInfo.data) {
        out[token.toBase58()] = null;
        needs2022.push(token);
        return;
      }

      try {
        const data = accountInfo.data as Buffer;

        let offset = 1 + 32 + 32;

        const nameLen = data.readUInt32LE(offset);
        offset += 4 + nameLen;

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
      } catch {
        out[token.toBase58()] = null;
        needs2022.push(token);
      }
    });

    if (needs2022.length) {
      const mintInfos = await this.batchGetMultipleAccountsInfo(
        needs2022,
        "getTokensSymbols/Token2022"
      );

      const ptrsToFetch: PublicKey[] = [];
      const ptrOwnerByKey = new Map<string, string>();

      needs2022.forEach((mint, idx) => {
        const info = mintInfos[idx] as AccountInfo<Buffer> | null;
        if (!info || !info.data) {
          return;
        }
        if (!info.owner.equals(TOKEN_2022_PROGRAM_ID)) {
          return;
        }

        const { symbol, ptr } = this.parseToken2022SymbolFromMintOrPtr(info.data);
        if (symbol) {
          out[mint.toBase58()] = symbol;
        } else if (ptr) {
          ptrsToFetch.push(ptr);
          ptrOwnerByKey.set(ptr.toBase58(), mint.toBase58());
        }
      });

      if (ptrsToFetch.length) {
        const pointerInfos = await this.batchGetMultipleAccountsInfo(
          ptrsToFetch,
          "getTokensSymbols/Token2022Pointer"
        );

        ptrsToFetch.forEach((ptrPk, idx) => {
          const pinfo = pointerInfos[idx] as AccountInfo<Buffer> | null;
          const mintB58 = ptrOwnerByKey.get(ptrPk.toBase58());
          if (!mintB58) return;
          if (!pinfo || !pinfo.data) {
            return;
          }
          try {
            const md = unpackToken2022Metadata(pinfo.data);
            const mdSymbol = md?.symbol;
            const symbol = mdSymbol ? mdSymbol.replace(/\0/g, "").trim() : null;
            if (symbol) {
              out[mintB58] = symbol;
            }
          } catch {
            // Failed to unpack pointer metadata
          }
        });
      }
    }

    return out;
  }

  public async getSupply(CAs: string[]) {
    const mintKeys: PublicKey[] = CAs.map((ca: string) => new PublicKey(ca));
    const mintInfos = await this.batchGetMultipleAccountsInfo(mintKeys, "getSupply");

    const results = mintInfos.map((accountInfo, idx) => {
      if (!accountInfo) {
        return { address: CAs[idx], error: "Account not found" };
      }

      const buf = accountInfo.data as Buffer;
      const u8 = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);

      const mint = MintLayout.decode(u8);

      const decimals: number = mint.decimals;
      const supply: bigint = BigInt(mint.supply.toString());

      let _denom = 1n;
      for (let i = 0; i < decimals; i++) _denom *= 10n;

      return {
        address: CAs[idx],
        biSupply: supply,
        human: new BigNumber(supply.toString()).dividedBy(10 ** decimals),
        decimals,
      };
    });

    const out = Object.fromEntries(
      results.map((r) => [
        r.address,
        {
          supply: r.biSupply,
          decimals: r.decimals,
          human: r.human,
        },
      ])
    );
    return out;
  }

  public async parseTokenAccounts(
    heldTokens: TokenAccountEntry[],
    options: { notOlderThan?: number } = {}
  ) {
    const nowInMs = Date.now();
    const acceptableInMs = options.notOlderThan ?? 60 * 60_000;
    let cache: Array<TokenMetaCacheEntry | null> = [];
    if (acceptableInMs !== 0) {
      cache = await Promise.all(
        heldTokens.map((t) =>
          this.runtime.getCache<TokenMetaCacheEntry | null>(
            `solana_token_meta_${t.account.data.parsed.info.mint}`
          )
        )
      );
    }

    let misses = 0;
    const fetchTokens: TokenAccountEntry[] = [];
    const goodCache: Record<
      string,
      {
        symbol: string | null;
        supply: string | number | null;
        tokenProgram: string;
        decimals: number;
        balanceUi: number;
        isMutable: boolean | null;
      }
    > = {};
    for (const i in heldTokens) {
      const t = heldTokens[i];
      if (cache[i]) {
        const c = cache[i];
        let useCache = false;
        if (c.data.isMutable === false) {
          useCache = true;
        } else if (acceptableInMs !== 0) {
          const diff = nowInMs - c.setAt;
          if (diff < acceptableInMs) {
            useCache = true;
          }
        }
        if (useCache) {
          const mint = t.account.data.parsed.info.mint;
          const { amount: raw, decimals } = t.account.data.parsed.info.tokenAmount;
          const balanceUi = Number(raw) / 10 ** decimals;

          goodCache[mint] = { ...c.data, balanceUi };
          continue;
        }
      }
      fetchTokens.push(heldTokens[i]);
      misses++;
    }
    this.runtime.logger.debug(
      "parseTokenAccounts",
      `${heldTokens.length - misses}/${heldTokens.length}`,
      "in cache"
    );
    const toB58 = (pk: string | PublicKey | { toBase58(): string }) =>
      typeof pk === "string" ? pk : pk.toBase58();

    const TOKEN_ID_B58 = TOKEN_PROGRAM_ID.toBase58();
    const TOKEN2022_B58 = TOKEN_2022_PROGRAM_ID.toBase58();

    const t22MintKeys: PublicKey[] = Array.from(
      new Set(
        fetchTokens
          .filter((t) => toB58(t.account.owner) === TOKEN2022_B58)
          .map((t) => t.account.data.parsed.info.mint as string)
      )
    ).map((s) => new PublicKey(s));

    const classicMintKeys: PublicKey[] = Array.from(
      new Set(
        fetchTokens
          .filter((t) => toB58(t.account.owner) === TOKEN_ID_B58)
          .map((t) => t.account.data.parsed.info.mint as string)
      )
    ).map((s) => new PublicKey(s));

    const allMintKeys: PublicKey[] = Array.from(
      new Set(fetchTokens.map((t) => t.account.data.parsed.info.mint))
    ).map((s) => new PublicKey(s));

    const mintInfos = await this.batchGetMultipleAccountsInfo(allMintKeys, "t22-mints");

    const hasT22Meta = new Set<string>();
    const t22IsMutable = new Map<string, boolean>();
    const t22Symbols = new Map<string, string>();
    const mpSymbols = new Map<string, string>();
    const mpSupply = new Map<string, string>();

    const stripNulls = (s: string) => s.replace(/\0+$/g, "").trim();
    function readBorshStringSafe(buf: Buffer, offObj: { off: number }): string {
      if (offObj.off + 4 > buf.length) return "";
      const len = buf.readUInt32LE(offObj.off);
      offObj.off += 4;
      if (len < 0 || offObj.off + len > buf.length) {
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

    function parseToken2022MetadataTLV(ext: Buffer): {
      isMutable: boolean;
      updateAuthority?: string;
      mint: string;
      name: string;
      symbol: string;
      uri: string;
      additional?: Array<[string, string]>;
    } {
      const o = { off: 0 };
      const uaBytes = ext.subarray(o.off, o.off + 32);
      o.off += 32;
      const isMutable = !allZero32(uaBytes);
      const updateAuthority = isMutable ? new PublicKey(uaBytes).toBase58() : undefined;

      const mint = new PublicKey(ext.subarray(o.off, o.off + 32)).toBase58();
      o.off += 32;

      const name = readVecU8AsString(ext, o);
      const symbol = readVecU8AsString(ext, o);
      const uri = readVecU8AsString(ext, o);

      const additional: Array<[string, string]> = [];
      if (o.off + 4 <= ext.length) {
        const n = readU32LE(ext, o);
        for (let i = 0; i < n; i++)
          additional.push([readVecU8AsString(ext, o), readVecU8AsString(ext, o)]);
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
      return decimals === 0 ? whole.toString() : `${whole}.${frac}`.replace(/\.$/, "");
    }

    allMintKeys.forEach((mk, i) => {
      const info = mintInfos[i];

      if (!info || !info.data) return;

      const infoOwner = info.owner;
      const isT22 =
        infoOwner?.toBase58 && infoOwner.toBase58() === TOKEN_2022_PROGRAM_ID.toBase58();
      const mintKeyStr = mk.toBase58();

      if (isT22) {
        const parsedMint = unpackMint(mk, info, TOKEN_2022_PROGRAM_ID);
        const uiSupply = formatSupplyUiAmount(parsedMint.supply, parsedMint.decimals);

        mpSupply.set(mintKeyStr, uiSupply);
        this.decimalsCache.set(mintKeyStr, parsedMint.decimals);

        const tlv = parsedMint.tlvData ?? Buffer.alloc(0);
        const mdExt = getExtensionData(ExtensionType.TokenMetadata, tlv);
        if (mdExt) {
          const res = parseToken2022MetadataTLV(mdExt);

          hasT22Meta.add(mintKeyStr);
          t22IsMutable.set(mintKeyStr, res.isMutable);
          t22Symbols.set(mintKeyStr, res.symbol);

          return;
        }
      } else {
        const infoData = info?.data;
        const buf = infoData as Buffer;
        const u8 = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);

        const header = u8.subarray(0, MintLayout.span);
        const mintData = MintLayout.decode(header);
        const uiSupply = formatSupplyUiAmount(mintData.supply, mintData.decimals);
        mpSupply.set(mintKeyStr, uiSupply);
        this.decimalsCache.set(mintKeyStr, mintData.decimals);
      }
    });

    const missingT22s = t22MintKeys.filter((m) => !hasT22Meta.has(m.toBase58()));
    const mpMintKeys = [...classicMintKeys, ...missingT22s];

    const mpAddrs: PublicKey[] = await Promise.all(
      mpMintKeys.map((m) => this.getMetadataAddress(m))
    );
    const mpInfos = mpAddrs.length
      ? await this.batchGetMultipleAccountsInfo(mpAddrs, "metaplex-md")
      : [];

    const mpIsMutable = new Map<string, boolean>();
    mpMintKeys.forEach((mk, i) => {
      const acc = mpInfos[i];
      const accData = acc?.data;
      const data = accData;
      if (!data || !data.length) return;

      const mintAddrStr = mk.toBase58();

      const limit = data.length;
      const need = (n: number) => n <= limit;

      const off = 1 + 32 + 32;
      if (!need(off)) return;

      const offObj = { off };
      readBorshStringSafe(data, offObj);
      const symbol = readBorshStringSafe(data, offObj);
      readBorshStringSafe(data, offObj);

      if (offObj.off + 2 > limit) return;
      data.readUInt16LE(offObj.off);
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

      if (offObj.off + 1 > limit) return;
      offObj.off += 1;

      if (offObj.off + 1 > limit) return;
      const isMutable = data.readUInt8(offObj.off) === 1;

      mpIsMutable.set(mintAddrStr, isMutable);
      mpSymbols.set(mintAddrStr, symbol);
    });

    const t22Set = new Set(t22MintKeys.map((k) => k.toBase58()));

    const results = heldTokens.map((t) => {
      const mintStr: string = t.account.data.parsed.info.mint as string;
      const mintKey: PublicKey = new PublicKey(mintStr);
      const is2022: boolean = t22Set.has(mintStr);

      const { amount: raw, decimals } = t.account.data.parsed.info.tokenAmount;
      const balanceUi: number = Number(raw) / 10 ** decimals;

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
        isMutable,
      };
    });

    (async () => {
      for (const t of results) {
        const { balanceUi: _balanceUi, mint: _mint, ...copy } = t;
        const key = `solana_token_meta_${t.mint}`;
        await this.runtime.setCache<TokenMetaCacheEntry>(key, {
          setAt: nowInMs,
          data: copy,
        });
      }
    })().catch((err) =>
      this.runtime.logger.error({ err }, "solana:parseTokenAccounts - cache save failed")
    );

    // then convert array to keyed object
    const out = Object.fromEntries(
      results.map((r) => [
        r.mint,
        {
          symbol: r.symbol,
          supply: r.supply,
          tokenProgram: r.tokenProgram,
          decimals: r.decimals,
          balanceUi: r.balanceUi,
          isMutable: r.isMutable,
        },
      ])
    );

    for (const mint in goodCache) {
      out[mint] = goodCache[mint];
    }

    return out;
  }

  private async getTokenAccounts() {
    const publicKey = await this.ensurePublicKey();
    if (!publicKey) return null;
    return this.getTokenAccountsByKeypair(publicKey);
  }

  public async getWalletKeypair(): Promise<Keypair> {
    const keypair = await this.ensureKeypair();
    if (!keypair) {
      throw new Error("Failed to get wallet keypair");
    }
    return keypair;
  }

  public async getPublicKey(): Promise<PublicKey | null> {
    return await this.ensurePublicKey();
  }

  public async updateWalletData(force = false): Promise<WalletPortfolio> {
    const now = Date.now();

    const publicKey = await this.ensurePublicKey();
    if (!publicKey) {
      logger.log("solana::updateWalletData - no Public Key yet");
      return { totalUsd: "0", items: [] };
    }

    if (!force && now - this.lastUpdate < this.UPDATE_INTERVAL) {
      const cached = await this.getCachedData();
      if (cached) return cached;
    }

    try {
      const birdeyeApiKey = this.runtime.getSetting("BIRDEYE_API_KEY");
      if (birdeyeApiKey) {
        try {
          const walletData = (await this.birdeyeFetchWithRetry(
            `${PROVIDER_CONFIG.BIRDEYE_API}/v1/wallet/token_list?wallet=${publicKey.toBase58()}`
          )) as BirdeyeWalletTokenListResponse;

          if (walletData?.success && walletData?.data) {
            const data = walletData.data;
            const totalUsd = new BigNumber(data.totalUsd.toString());
            const prices = await this.fetchPrices();
            const solPriceInUSD = new BigNumber(prices.solana.usd);

            const missingSymbols = data.items.filter((i) => !i.symbol);

            if (missingSymbols.length) {
              const symbols: Record<string, string | null> = await this.getTokensSymbols(
                missingSymbols.map((i) => i.address)
              );
              for (const i in data.items) {
                const item = data.items[i];
                if (symbols[item.address]) {
                  data.items[i].symbol = symbols[item.address];
                }
              }
            }

            const portfolio: WalletPortfolio = {
              totalUsd: totalUsd.toString(),
              totalSol: totalUsd.div(solPriceInUSD).toFixed(6),
              prices,
              lastUpdated: now,
              items: data.items.map((item: Item) => ({
                ...item,
                valueSol: new BigNumber(item.valueUsd || 0).div(solPriceInUSD).toFixed(6),
                name: item.name || "Unknown",
                symbol: item.symbol || "Unknown",
                priceUsd: item.priceUsd || "0",
                valueUsd: item.valueUsd || "0",
              })),
            };

            await this.runtime.setCache<WalletPortfolio>(SOLANA_WALLET_DATA_CACHE_KEY, portfolio);
            this.lastUpdate = now;
            return portfolio;
          }
        } catch (e) {
          this.runtime.logger.error({ err: e }, "solana::updateWalletData - exception");
        }
      }

      logger.log("Using RPC fallback for wallet data (no Birdeye)");
      const accounts = await this.getTokenAccounts();
      if (!accounts || accounts.length === 0) {
        logger.log("No token accounts found");
        const emptyPortfolio: WalletPortfolio = {
          totalUsd: "0",
          totalSol: "0",
          items: [],
        };
        await this.runtime.setCache<WalletPortfolio>(SOLANA_WALLET_DATA_CACHE_KEY, emptyPortfolio);
        this.lastUpdate = now;
        return emptyPortfolio;
      }

      const tokenMetadata = await this.parseTokenAccounts(accounts);

      const items: Item[] = accounts.map((acc) => {
        const mint = acc.account.data.parsed.info.mint;
        const metadata = tokenMetadata[mint];

        this.decimalsCache.set(mint, acc.account.data.parsed.info.tokenAmount.decimals);

        return {
          name: metadata?.symbol || "",
          address: mint,
          symbol: metadata?.symbol || "",
          decimals: acc.account.data.parsed.info.tokenAmount.decimals,
          balance: acc.account.data.parsed.info.tokenAmount.amount,
          uiAmount: acc.account.data.parsed.info.tokenAmount.uiAmount.toString(),
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

      await this.runtime.setCache<WalletPortfolio>(SOLANA_WALLET_DATA_CACHE_KEY, portfolio);
      this.lastUpdate = now;
      return portfolio;
    } catch (error) {
      logger.error(`Error updating wallet data: ${error}`);
      throw error;
    }
  }

  public async getCachedData(): Promise<WalletPortfolio | null> {
    const cachedValue = await this.runtime.getCache<WalletPortfolio>(SOLANA_WALLET_DATA_CACHE_KEY);
    if (cachedValue) {
      return cachedValue;
    }
    return null;
  }

  public async forceUpdate(): Promise<WalletPortfolio> {
    return await this.updateWalletData(true);
  }

  public async createWallet(): Promise<{
    publicKey: string;
    privateKey: string;
  }> {
    try {
      const newKeypair = Keypair.generate();
      const publicKey = newKeypair.publicKey.toBase58();
      const privateKey = bs58.encode(newKeypair.secretKey);
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

  public async getTokenAccountsByKeypair(
    walletAddress: PublicKey,
    options: { notOlderThan?: number; includeZeroBalances?: boolean } = {}
  ): Promise<KeyedParsedTokenAccount[]> {
    const key = `solana_${walletAddress.toString()}_tokens`;
    try {
      const now = Date.now();
      if (options.notOlderThan !== undefined && options.notOlderThan !== 0) {
        const check = await this.runtime.getCache<CacheWrapper<KeyedParsedTokenAccount[]>>(key);
        if (check) {
          const diff = now - check.exp;
          const acceptableInMs: number = options.notOlderThan ?? 60_000;
          if (diff < acceptableInMs) {
            return check.data;
          }
        }
      }

      const [accounts, token2022s]: [ParsedTokenAccountsResponse, ParsedTokenAccountsResponse] =
        await Promise.all([
          this.connection.getParsedTokenAccountsByOwner(walletAddress, {
            programId: TOKEN_PROGRAM_ID,
          }),
          this.connection.getParsedTokenAccountsByOwner(walletAddress, {
            programId: TOKEN_2022_PROGRAM_ID,
          }),
        ]);
      const allTokens: KeyedParsedTokenAccount[] = [...token2022s.value, ...accounts.value];

      const haveAllTokens: KeyedParsedTokenAccount[] = [];
      for (const t of allTokens) {
        const { amount, decimals } = t.account.data.parsed.info.tokenAmount;
        this.decimalsCache.set(t.account.data.parsed.info.mint, decimals);
        if (options.includeZeroBalances || amount !== "0") {
          haveAllTokens.push(t);
        }
      }

      await this.runtime.setCache<{ fetchedAt: number; data: KeyedParsedTokenAccount[] }>(key, {
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
    options = {}
  ): Promise<Record<string, KeyedParsedTokenAccount[]>> {
    const res = await Promise.all(
      walletAddresses.map((a) => this.getTokenAccountsByKeypair(new PublicKey(a), options))
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

  public async getBalancesByAddrs(walletAddressArr: string[]): Promise<Record<string, number>> {
    try {
      const publicKeyObjs = walletAddressArr.map((k) => new PublicKey(k));
      const accounts = await this.batchGetMultipleAccountsInfo(publicKeyObjs, "getBalancesByAddrs");

      const out: Record<string, number> = {};
      for (let i = 0; i < accounts.length; i++) {
        const a = accounts[i];
        const pk = walletAddressArr[i];
        if (pk === undefined) continue;
        if (a?.lamports) {
          out[pk] = a.lamports * SolanaService.LAMPORTS2SOL;
        } else {
          out[pk] = 0;
        }
      }
      return out;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes("429")) {
        this.runtime.logger.warn("RPC rate limit hit, pausing before retry");
        await new Promise((waitResolve) => setTimeout(waitResolve, 1000));
        return this.getBalancesByAddrs(walletAddressArr);
      }
      this.runtime.logger.error(`solSrv:getBalancesByAddrs - unexpected error: ${error}`);
      return {};
    }
  }

  async walletAddressToHumanString(pubKey: string): Promise<string> {
    let balanceStr = "";
    const pubKeyObj = new PublicKey(pubKey);

    const [balances, heldTokens] = await Promise.all([
      this.getBalancesByAddrs([pubKey]),
      this.getTokenAccountsByKeypair(pubKeyObj),
    ]);
    const solBal = balances[pubKey];

    balanceStr += `Wallet Address: ${pubKey}\n`;
    balanceStr += "  Token Address (Symbol)\n";
    balanceStr += `  So11111111111111111111111111111111111111111 ($sol) balance: ${solBal ?? "0"}\n`;
    const tokens = await this.parseTokenAccounts(heldTokens);
    for (const ca in tokens) {
      const t = tokens[ca];
      balanceStr += `  ${ca} ($${t.symbol}) balance: ${t.balanceUi}\n`;
    }
    balanceStr += "\n";
    return balanceStr;
  }

  async walletAddressToLLMString(pubKey: string): Promise<string> {
    let balanceStr = "";
    const pubKeyObj = new PublicKey(pubKey);
    const [balances, heldTokens] = await Promise.all([
      this.getBalancesByAddrs([pubKey]),
      this.getTokenAccountsByKeypair(pubKeyObj),
    ]);
    const solBal = balances[pubKey];
    balanceStr += `Wallet Address: ${pubKey}\n`;
    balanceStr += "Current wallet contents in csv format:\n";
    balanceStr += "Token Address,Symbol,Balance\n";
    balanceStr += `So11111111111111111111111111111111111111111,sol,${solBal ?? "0"}\n`;
    const tokens = await this.parseTokenAccounts(heldTokens);
    for (const ca in tokens) {
      const t = tokens[ca];
      balanceStr += `${ca},${t.symbol},${t.balanceUi}\n`;
    }
    balanceStr += "\n";
    return balanceStr;
  }

  public async getWalletBalances(
    publicKeyStr: string,
    mintAddresses: string[]
  ): Promise<Record<string, MintBalance | null>> {
    const owner = new PublicKey(publicKeyStr);
    const mints = mintAddresses.map((m) => new PublicKey(m));

    const ataPairs = mints.map((mint) => {
      const ataTokenV1 = getAssociatedTokenAddressSync(mint, owner, false, TOKEN_PROGRAM_ID);
      const ata2022 = getAssociatedTokenAddressSync(mint, owner, false, TOKEN_2022_PROGRAM_ID);
      return { mint, ataTokenV1, ata2022 };
    });

    const allAtaAddrs = ataPairs.flatMap((p) => [p.ataTokenV1, p.ata2022]);
    const ataInfos = await this.batchGetMultipleAccountsInfo(allAtaAddrs, "getWalletBalances");
    const mintInfos = await this.batchGetMultipleAccountsInfo(mints, "getWalletBalances");

    const mintDecimals = new Map<string, number>();
    mints.forEach((mintPk, i) => {
      const acc = mintInfos[i];
      if (!acc) return;
      const mintData = MintLayout.decode(acc.data);
      mintDecimals.set(mintPk.toBase58(), mintData.decimals);
    });

    const byAddress = new Map<string, ReturnType<typeof AccountLayout.decode> | null>();
    allAtaAddrs.forEach((ata, i) => {
      const info = ataInfos[i];
      if (!info) {
        byAddress.set(ata.toBase58(), null);
        return;
      }
      byAddress.set(ata.toBase58(), AccountLayout.decode(info.data));
    });

    // 5) Assemble balances; prefer Token Program V1 over 2022 if both exist
    const out: Record<string, MintBalance | null> = {};

    for (const { mint, ataTokenV1, ata2022 } of ataPairs) {
      const mintStr = mint.toBase58();
      const decimals = mintDecimals.get(mintStr);
      // If we don’t know decimals (mint account not found), we can’t compute uiAmount
      if (decimals === undefined) {
        out[mintStr] = null;
        continue;
      }

      const tokenV1 = byAddress.get(ataTokenV1.toBase58());
      const tok2022 = byAddress.get(ata2022.toBase58());

      // Choose which token account to use:
      const chosen = tokenV1 ?? tok2022;
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

  public async getTokenBalanceForWallets(
    mint: PublicKey,
    walletAddresses: string[]
  ): Promise<Record<string, number>> {
    const walletPubkeys = walletAddresses.map((a) => new PublicKey(a));
    const atAs = walletPubkeys.map((w) => getAssociatedTokenAddressSync(mint, w));
    const balances: Record<string, number> = {};

    const decimals = await this.getDecimal(mint);
    const infos = await this.batchGetMultipleAccountsInfo(atAs, "getTokenBalanceForWallets");

    infos.forEach((info, idx) => {
      const walletPubkey = walletPubkeys[idx];
      const ata = atAs[idx];
      if (walletPubkey === undefined || ata === undefined) {
        return;
      }
      const walletKey = walletPubkey.toBase58();
      let uiAmount = 0;

      const infoData = info?.data;
      if (infoData) {
        const account = unpackAccount(ata, info);
        const raw = account.amount;
        uiAmount = Number(raw) / 10 ** decimals;
      }

      balances[walletKey] = uiAmount;
    });

    return balances;
  }

  public async subscribeToAccount(
    accountAddress: string,
    handler: (address: string, accountInfo: AccountInfo<Buffer>, context: Context) => void
  ): Promise<number> {
    try {
      if (!this.validateAddress(accountAddress)) {
        throw new Error("Invalid account address");
      }

      // Check if already subscribed
      const existingSubscription = this.subscriptions.get(accountAddress);
      if (existingSubscription !== undefined) {
        return existingSubscription;
      }

      const accountPubkeyObj = new PublicKey(accountAddress);
      const subscriptionId = this.connection.onAccountChange(
        accountPubkeyObj,
        (accountInfo, context) => {
          handler(accountAddress, accountInfo, context);
        },
        "finalized"
      );

      this.subscriptions.set(accountAddress, subscriptionId);
      logger.log(`Subscribed to account ${accountAddress} with ID ${subscriptionId}`);
      return subscriptionId;
    } catch (error) {
      logger.error(`Error subscribing to account: ${error}`);
      throw error;
    }
  }

  public async unsubscribeFromAccount(accountAddress: string): Promise<boolean> {
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

  public async calculateOptimalBuyAmount(
    inputMint: string,
    outputMint: string,
    availableAmount: number
  ): Promise<{ amount: number; slippage: number }> {
    try {
      const priceImpact = await this.jupiterService.getPriceImpact({
        inputMint,
        outputMint,
        amount: availableAmount,
      });

      const slippage = await this.jupiterService.findBestSlippage({
        inputMint,
        outputMint,
        amount: availableAmount,
      });

      let optimalAmount = availableAmount;
      if (priceImpact > 5) {
        optimalAmount = availableAmount * 0.5;
      }

      return { amount: optimalAmount, slippage };
    } catch (error) {
      logger.error(`Error calculating optimal buy amount: ${error}`);
      throw error;
    }
  }

  public async calculateOptimalBuyAmount2(
    quote: JupiterQuote,
    availableAmount: number
  ): Promise<{ amount: number; slippage: number }> {
    try {
      const priceImpact = Number(quote.priceImpactPct);

      let optimalAmount = availableAmount;
      if (priceImpact > 5) {
        optimalAmount = availableAmount * 0.5;
      }

      let recommendedSlippage: number;
      if (priceImpact < 0.5) {
        recommendedSlippage = 50;
      } else if (priceImpact < 1) {
        recommendedSlippage = 100;
      } else {
        recommendedSlippage = 200;
      }

      return { amount: optimalAmount, slippage: recommendedSlippage };
    } catch (error) {
      logger.error(`calculateOptimalBuyAmount2 - Error calculating optimal buy amount: ${error}`);
      throw error;
    }
  }

  public async executeSwap(
    wallets: SwapWalletEntry[],
    signal: TradingSignal
  ): Promise<Record<string, SwapExecutionResponse>> {
    if (!this.jupiterService) {
      throw new Error("Jupiter service not available");
    }
    const swapResponses: Record<string, SwapExecutionResponse> = {};
    for (const wallet of wallets) {
      const pubKey = wallet.keypair.publicKey.toString();
      try {
        const intAmount: number = parseInt(wallet.amount.toString(), 10);
        if (Number.isNaN(intAmount) || intAmount <= 0) {
          swapResponses[pubKey] = {
            success: false,
            error: "bad amount",
          };
          continue;
        }

        const balances = await this.getBalancesByAddrs([pubKey]);
        const bal = balances[pubKey] ?? 0;

        const estimateLamportsNeeded = this.jupiterService.estimateLamportsNeeded;
        if (!estimateLamportsNeeded) {
          swapResponses[pubKey] = {
            success: false,
            error: "estimateLamportsNeeded not available",
          };
          continue;
        }
        const baseLamports = estimateLamportsNeeded({
          inputMint: signal.sourceTokenCA,
          inAmount: intAmount,
        });
        const ourLamports = bal * 1e9;
        if (baseLamports > ourLamports) {
          swapResponses[pubKey] = {
            success: false,
            error: "not enough SOL",
          };
          continue;
        }
        const initialQuote = await this.jupiterService.getQuote({
          inputMint: signal.sourceTokenCA,
          outputMint: signal.targetTokenCA,
          slippageBps: 200,
          amount: String(intAmount),
        });

        const quoteWithLamports = initialQuote as JupiterQuote & { totalLamportsNeeded?: number };

        const availableLamports = bal * 1e9;
        const totalLamportsNeededForSwap = quoteWithLamports.totalLamportsNeeded;
        if (totalLamportsNeededForSwap && totalLamportsNeededForSwap > availableLamports) {
          swapResponses[pubKey] = {
            success: false,
            error: "not enough SOL",
          };
          continue;
        }

        const outAmountNum = Number(initialQuote.outAmount);
        const otherAmountThresholdNum = Number(initialQuote.otherAmountThreshold);
        const impliedSlippageBps: number =
          ((outAmountNum - otherAmountThresholdNum) / outAmountNum) * 10_000;

        const { amount } = await this.calculateOptimalBuyAmount2(initialQuote, wallet.amount);

        initialQuote.inAmount = `${amount}`;

        // Execute the swap
        let swapResponse: JupiterSwapResult | undefined;
        const executeSwapFn = this.jupiterService.executeSwap;
        if (!executeSwapFn) {
          swapResponses[pubKey] = {
            success: false,
            error: "executeSwap method not available",
          };
          continue;
        }
        const executeSwap = async (impliedSlippageBps: number) => {
          swapResponse = await executeSwapFn({
            quoteResponse: initialQuote,
            userPublicKey: pubKey,
            slippageBps: parseInt(impliedSlippageBps.toString(), 10),
          });

          const secretKey = bs58.decode(bs58.encode(wallet.keypair.secretKey));
          const keypair = Keypair.fromSecretKey(secretKey);

          if (!swapResponse?.swapTransaction) {
            throw new Error("Swap response missing transaction");
          }
          const txBuffer = Buffer.from(swapResponse.swapTransaction, "base64");
          const transaction = VersionedTransaction.deserialize(Uint8Array.from(txBuffer));
          transaction.sign([keypair]);

          let txid = "";
          try {
            txid = await this.connection.sendRawTransaction(transaction.serialize());
          } catch (err) {
            if (err instanceof SendTransactionError) {
              const logs = err.logs || (await err.getLogs(this.connection));

              if (logs) {
                if (logs.some((l) => l.includes("custom program error: 0x1771"))) {
                  if (signal.targetTokenCA === "So11111111111111111111111111111111111111112") {
                    if (impliedSlippageBps < 3000) {
                      await new Promise((resolve) => setTimeout(resolve, 1000));
                      return executeSwap(impliedSlippageBps * 2);
                    }
                  }
                }
              }
            }
            throw err;
          }
          return txid;
        };

        const txid = await executeSwap(impliedSlippageBps);

        await this.connection.confirmTransaction(txid, "finalized");

        const txDetails = await this.connection.getTransaction(txid, {
          commitment: "confirmed",
          maxSupportedTransactionVersion: 0,
        });

        let outAmount = initialQuote.outAmount;

        const txDetailsMeta = txDetails?.meta;
        const preTokenBalances = txDetailsMeta?.preTokenBalances;
        const postTokenBalances = txDetailsMeta?.postTokenBalances;
        if (preTokenBalances && postTokenBalances) {
          const tokenCA = signal.targetTokenCA;

          const inBal = preTokenBalances.find((tb) => tb.owner === pubKey && tb.mint === tokenCA);
          const outBal = postTokenBalances.find((tb) => tb.owner === pubKey && tb.mint === tokenCA);
          const outBalUiTokenAmount = outBal?.uiTokenAmount;

          if (outBalUiTokenAmount?.decimals) {
            this.decimalsCache.set(tokenCA, outBalUiTokenAmount.decimals);
          }

          if (signal.targetTokenCA === "So11111111111111111111111111111111111111112") {
            if (inBal && outBal) {
              const diff =
                Number(inBal.uiTokenAmount.amount ?? 0) - Number(outBal.uiTokenAmount.amount ?? 0);
              if (diff) {
                outAmount = String(diff);
              }
            } else if (outBal) {
              const amt = Number(outBal.uiTokenAmount.amount);
              if (amt) {
                outAmount = String(amt);
              }
            }
          } else {
            if (inBal && outBal) {
              const diff =
                Number(outBal.uiTokenAmount.amount ?? 0) - Number(inBal.uiTokenAmount.amount ?? 0);
              if (diff) {
                outAmount = String(diff);
              }
            } else if (outBal) {
              const amt = Number(outBal.uiTokenAmount.amount);
              if (amt) {
                outAmount = String(amt);
              }
            }
          }
        }

        const fee = txDetailsMeta?.fee;
        const fees = {
          lamports: fee,
          sol: fee ? fee * SolanaService.LAMPORTS2SOL : 0,
        };

        swapResponses[pubKey] = {
          success: true,
          outAmount: typeof outAmount === "string" ? outAmount : String(outAmount || 0),
          signature: txid,
          fees: fees
            ? {
                lamports: fees.lamports || 0,
                sol: fees.sol || 0,
              }
            : undefined,
          swapResponse,
        };
      } catch (error) {
        logger.error(`Error in swap execution: ${error}`);
        swapResponses[pubKey] = { success: false };
      }
    }

    return swapResponses;
  }

  static async start(runtime: IAgentRuntime): Promise<Service> {
    runtime.logger.log(`SolanaService start for ${runtime.character.name}`);

    const solanaService = new SolanaService(runtime);
    return solanaService;
  }

  static async stop(runtime: IAgentRuntime): Promise<void> {
    const client = runtime.getService(SOLANA_SERVICE_NAME) as SolanaService | null;
    if (!client) {
      runtime.logger.error("SolanaService not found during static stop");
      return;
    }
    await client.stop();
  }

  async stop(): Promise<void> {
    this.runtime.logger.info("SolanaService: Stopping instance...");
    for (const [address] of this.subscriptions) {
      await this.unsubscribeFromAccount(address).catch((e) =>
        this.runtime.logger.error(
          `Error unsubscribing from ${address} during stop:`,
          e instanceof Error ? e.message : String(e)
        )
      );
    }
    this.subscriptions.clear();
  }
}
