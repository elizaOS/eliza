/**
 * Clawd Code — Cheshire Terminal Agent Arena Client
 * On-chain Solana agent identity (Metaplex Core NFTs), discovery, hiring,
 * and ATOM reputation — all via cheshireterminal.ai REST API.
 *
 * Identity scheme: svm://solana-mainnet/<metaplex-core-asset-address>
 */

const CT_BASE = 'https://cheshireterminal.ai/api/metaplex-agents';

export const CLAWD_MINT = '8cHzQHUS2s2h8TzCmfqPKYiM4dSt4roa3n7MyRLApump';

// ── Types ────────────────────────────────────────────────────────────────────

export interface ArenaService {
  name: 'x402' | 'A2A' | 'MCP' | 'OASF' | 'web' | string;
  endpoint: string;
  version?: string;
}

export interface MintParams {
  name: string;
  walletAddress: string;
  description: string;
  capabilities?: string[];
  image?: string;
}

export interface MintResult {
  assetAddress: string;
  mintSignature: string;
  globalId: string;
  network: string;
  ownerWallet: string;
  status: string;
}

export interface RegisterParams {
  assetAddress: string;
  walletAddress: string;
  name: string;
  description: string;
  capabilities?: string[];
  services?: ArenaService[];
  pricing?: { per_task?: number; currency?: string; mint?: string };
  agentWallet?: string;
  supportedTrust?: string[];
  a2a?: boolean;
  mcp?: boolean;
  image?: string;
}

export interface RegisterResult {
  assetAddress: string;
  globalId: string;
  registerSignature: string;
  profileUrl: string;
  a2aCardUrl?: string;
  mcpServerCardUrl?: string;
  status: string;
}

export interface AgentProfile {
  name: string;
  description: string;
  capabilities: string[];
  services: ArenaService[];
  agentWallet?: string;
  globalId?: string;
  reputation?: { score: number; reviewCount: number };
  a2aCardUrl?: string;
  mcpServerCardUrl?: string;
}

export interface ReviewParams {
  agentGlobalId: string;
  score: number;
  tag1?: string;
  tag2?: string;
  feedbackNote?: string;
  proofOfPayment: {
    txSignature: string;
    fromWallet: string;
    toWallet: string;
    network?: string;
    mint?: string;
  };
}

// ── Client ───────────────────────────────────────────────────────────────────

export class ArenaClient {
  private async get<T>(path: string): Promise<T> {
    const res = await fetch(`${CT_BASE}${path}`);
    if (!res.ok) throw new Error(`CT ${res.status}: ${await res.text()}`);
    return res.json() as Promise<T>;
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${CT_BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`CT ${res.status}: ${await res.text()}`);
    return res.json() as Promise<T>;
  }

  async mint(params: MintParams): Promise<MintResult> {
    return this.post<MintResult>('/mint', { network: 'mainnet-beta', ...params });
  }

  async register(params: RegisterParams): Promise<RegisterResult> {
    return this.post<RegisterResult>('/register', params);
  }

  async fetch(assetAddress: string): Promise<AgentProfile> {
    return this.get<AgentProfile>(`/fetch/${assetAddress}`);
  }

  async review(params: ReviewParams): Promise<{ ok: boolean; message?: string }> {
    return this.post('/review', {
      ...params,
      proofOfPayment: {
        network: 'solana-mainnet',
        mint: CLAWD_MINT,
        ...params.proofOfPayment,
      },
    });
  }

  async health(): Promise<{ ok: boolean }> {
    const res = await fetch('https://cheshireterminal.ai/api/developer/status');
    return { ok: res.ok };
  }

  globalId(assetAddress: string): string {
    return `svm://solana-mainnet/${assetAddress}`;
  }
}

export const arena = new ArenaClient();
