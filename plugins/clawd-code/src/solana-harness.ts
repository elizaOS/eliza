/**
 * Solana blockchain harness primitives.
 * Read-first JSON-RPC wrapper with explicit mutation gates for transaction paths.
 */

export const LAMPORTS_PER_SOL = 1_000_000_000;
export const DEFAULT_SOLANA_RPC_URL = 'https://api.mainnet-beta.solana.com';

export type SolanaCluster = 'mainnet-beta' | 'devnet' | 'testnet' | 'localnet' | 'custom';
export type SolanaCommitment = 'processed' | 'confirmed' | 'finalized';

export interface SolanaHarnessConfig {
  rpcUrl: string;
  wsUrl?: string;
  cluster: SolanaCluster;
  commitment: SolanaCommitment;
  readOnly: boolean;
  liveTrading: boolean;
  operatorConfirmed: boolean;
  allowUnsafeRpc: boolean;
}

export interface RpcErrorPayload {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcEnvelope<T> {
  jsonrpc: '2.0';
  id: number;
  result?: T;
  error?: RpcErrorPayload;
}

export interface RpcAccountInfo<TData = unknown> {
  lamports: number;
  owner: string;
  data: TData;
  executable: boolean;
  rentEpoch: number;
  space?: number;
}

export interface ProgramAccount<TData = unknown> {
  pubkey: string;
  account: RpcAccountInfo<TData>;
}

export interface SolanaSnapshot {
  cluster: SolanaCluster;
  rpcUrl: string;
  commitment: SolanaCommitment;
  readOnly: boolean;
  health?: string;
  version?: unknown;
  slot?: number;
  epochInfo?: unknown;
  latestBlockhash?: unknown;
  prioritizationFees?: unknown;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]+$/;
const MUTATION_RPC_METHODS = new Set([
  'sendTransaction',
  'sendEncodedTransaction',
]);

function envValue(env: Record<string, string | undefined>, key: string): string | undefined {
  const value = env[key]?.trim();
  return value || undefined;
}

export function inferSolanaCluster(rpcUrl: string, explicit?: string): SolanaCluster {
  const declared = explicit?.trim().toLowerCase();
  if (declared === 'mainnet-beta' || declared === 'devnet' || declared === 'testnet' || declared === 'localnet') {
    return declared;
  }

  const normalized = rpcUrl.toLowerCase();
  if (normalized.includes('devnet')) return 'devnet';
  if (normalized.includes('testnet')) return 'testnet';
  if (normalized.includes('localhost') || normalized.includes('127.0.0.1') || normalized.includes('0.0.0.0')) {
    return 'localnet';
  }
  if (normalized.includes('mainnet')) return 'mainnet-beta';
  return 'custom';
}

export function normalizeCommitment(value: string | undefined): SolanaCommitment {
  const normalized = value?.trim().toLowerCase();
  if (normalized === 'processed' || normalized === 'confirmed' || normalized === 'finalized') return normalized;
  return 'confirmed';
}

export function resolveSolanaHarnessConfig(
  env: Record<string, string | undefined> = process.env,
): SolanaHarnessConfig {
  const heliusKey = envValue(env, 'HELIUS_API_KEY');
  const rpcUrl =
    envValue(env, 'SOLANA_RPC_URL') ||
    envValue(env, 'HELIUS_RPC_URL') ||
    (heliusKey ? `https://mainnet.helius-rpc.com/?api-key=${heliusKey}` : DEFAULT_SOLANA_RPC_URL);

  return {
    rpcUrl,
    wsUrl: envValue(env, 'SOLANA_WS_URL'),
    cluster: inferSolanaCluster(rpcUrl, envValue(env, 'SOLANA_CLUSTER')),
    commitment: normalizeCommitment(envValue(env, 'SOLANA_COMMITMENT')),
    readOnly: env.SOLANA_HARNESS_READONLY !== 'false',
    liveTrading: env.LIVE_TRADING === 'true',
    operatorConfirmed: env.OPERATOR_CONFIRMED === 'true',
    allowUnsafeRpc: env.SOLANA_HARNESS_ALLOW_UNSAFE_RPC === 'true',
  };
}

export function isSolanaAddress(value: string | undefined): boolean {
  return Boolean(value && value.length >= 32 && value.length <= 44 && BASE58_RE.test(value));
}

export function shortAddress(value: string, left = 6, right = 6): string {
  if (value.length <= left + right + 3) return value;
  return `${value.slice(0, left)}...${value.slice(-right)}`;
}

export function lamportsToSol(lamports: number): number {
  return lamports / LAMPORTS_PER_SOL;
}

export function formatSol(lamports: number): string {
  const sol = lamportsToSol(lamports);
  return `${sol.toLocaleString('en-US', { maximumFractionDigits: 9 })} SOL`;
}

export function isMutationRpcMethod(method: string): boolean {
  return MUTATION_RPC_METHODS.has(method);
}

export function canMutateSolana(config: SolanaHarnessConfig): boolean {
  return !config.readOnly && config.liveTrading && config.operatorConfirmed;
}

export class SolanaHarnessRpcClient {
  private id = 1;

  constructor(
    readonly config: SolanaHarnessConfig,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  async request<T = unknown>(method: string, params: unknown[] = [], timeoutMs = 15_000): Promise<T> {
    if (isMutationRpcMethod(method) && !canMutateSolana(this.config)) {
      throw new Error(
        `${method} is blocked. Set SOLANA_HARNESS_READONLY=false, LIVE_TRADING=true, and OPERATOR_CONFIRMED=true to allow mutation RPC.`,
      );
    }

    const response = await this.fetchImpl(this.config.rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: this.id++,
        method,
        params,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) {
      throw new Error(`Solana RPC HTTP ${response.status}: ${await response.text()}`);
    }

    const payload = (await response.json()) as JsonRpcEnvelope<T>;
    if (payload.error) {
      throw new Error(`Solana RPC ${payload.error.code}: ${payload.error.message}`);
    }
    return payload.result as T;
  }

  getHealth(): Promise<string> {
    return this.request<string>('getHealth', []);
  }

  getVersion(): Promise<unknown> {
    return this.request('getVersion', []);
  }

  getSlot(): Promise<number> {
    return this.request<number>('getSlot', [{ commitment: this.config.commitment }]);
  }

  getEpochInfo(): Promise<unknown> {
    return this.request('getEpochInfo', [{ commitment: this.config.commitment }]);
  }

  getLatestBlockhash(): Promise<unknown> {
    return this.request('getLatestBlockhash', [{ commitment: this.config.commitment }]);
  }

  getBalance(address: string): Promise<{ value: number }> {
    return this.request('getBalance', [address, { commitment: this.config.commitment }]);
  }

  getAccountInfo<TData = unknown>(address: string, encoding = 'jsonParsed'): Promise<{ value: RpcAccountInfo<TData> | null }> {
    return this.request('getAccountInfo', [
      address,
      {
        encoding,
        commitment: this.config.commitment,
      },
    ]);
  }

  getTransaction(signature: string): Promise<unknown> {
    return this.request('getTransaction', [
      signature,
      {
        encoding: 'jsonParsed',
        commitment: this.config.commitment,
        maxSupportedTransactionVersion: 0,
      },
    ]);
  }

  getSignaturesForAddress(address: string, limit = 10): Promise<unknown[]> {
    return this.request('getSignaturesForAddress', [
      address,
      {
        limit,
        commitment: this.config.commitment,
      },
    ]);
  }

  getProgramAccounts(programId: string): Promise<ProgramAccount[]> {
    return this.request('getProgramAccounts', [
      programId,
      {
        encoding: 'base64',
        commitment: this.config.commitment,
        dataSlice: { offset: 0, length: 0 },
      },
    ]);
  }

  getTokenSupply(mint: string): Promise<unknown> {
    return this.request('getTokenSupply', [mint, { commitment: this.config.commitment }]);
  }

  getTokenLargestAccounts(mint: string): Promise<unknown> {
    return this.request('getTokenLargestAccounts', [mint, { commitment: this.config.commitment }]);
  }

  getTokenAccountsByOwner(owner: string, filter: { mint?: string; programId?: string }): Promise<unknown> {
    return this.request('getTokenAccountsByOwner', [
      owner,
      filter.mint ? { mint: filter.mint } : { programId: filter.programId ?? 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' },
      {
        encoding: 'jsonParsed',
        commitment: this.config.commitment,
      },
    ]);
  }

  getRecentPrioritizationFees(addresses: string[] = []): Promise<unknown> {
    return this.request('getRecentPrioritizationFees', addresses.length ? [addresses] : []);
  }

  requestAirdrop(address: string, sol: number): Promise<string> {
    if (this.config.cluster === 'mainnet-beta') {
      throw new Error('Airdrop is unavailable on mainnet-beta.');
    }
    return this.request('requestAirdrop', [address, Math.round(sol * LAMPORTS_PER_SOL)]);
  }

  simulateTransaction(base64Transaction: string): Promise<unknown> {
    return this.request('simulateTransaction', [
      base64Transaction,
      {
        encoding: 'base64',
        commitment: this.config.commitment,
        sigVerify: false,
        replaceRecentBlockhash: true,
      },
    ]);
  }

  sendRawTransaction(base64Transaction: string): Promise<string> {
    return this.request('sendTransaction', [
      base64Transaction,
      {
        encoding: 'base64',
        skipPreflight: false,
        preflightCommitment: this.config.commitment,
      },
    ]);
  }
}

async function settle<T>(value: Promise<T>): Promise<T | { error: string }> {
  try {
    return await value;
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

export async function collectSolanaSnapshot(client: SolanaHarnessRpcClient): Promise<SolanaSnapshot> {
  const [health, version, slot, epochInfo, latestBlockhash, prioritizationFees] = await Promise.all([
    settle(client.getHealth()),
    settle(client.getVersion()),
    settle(client.getSlot()),
    settle(client.getEpochInfo()),
    settle(client.getLatestBlockhash()),
    settle(client.getRecentPrioritizationFees()),
  ]);

  return {
    cluster: client.config.cluster,
    rpcUrl: client.config.rpcUrl,
    commitment: client.config.commitment,
    readOnly: client.config.readOnly,
    health: typeof health === 'string' ? health : undefined,
    version,
    slot: typeof slot === 'number' ? slot : undefined,
    epochInfo,
    latestBlockhash,
    prioritizationFees,
  };
}
