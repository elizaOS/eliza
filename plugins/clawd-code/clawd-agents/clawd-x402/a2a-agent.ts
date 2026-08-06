/**
 * Google A2A (Agent-to-Agent) Protocol Client for Solana-Clawd
 *
 * Implements the Google A2A spec for agent-to-agent communication,
 * extended with Solana x402 payment gates so agents can charge each other
 * for services using USDC on-chain.
 *
 * Sponsor integrations: Google A2A + x402 + pay.sh + AP2 + MPP
 *
 * Reference: https://google.github.io/A2A/
 *
 * Flow:
 *  1. Discover peer via /.well-known/agent.json (A2A agent card)
 *  2. Submit task to peer's /tasks endpoint
 *  3. If 402 → pay via x402/AP2 using clawdFetch or PayshFacilitator
 *  4. Poll or stream results via SSE
 *  5. Emit TaskResult with provenance + payment receipt
 */

import type { Connection, Keypair } from '@solana/web3.js';
import type { ClawdFetchOptions } from './client-sdk.js';
import { clawdFetch } from './client-sdk.js';
import { PayshFacilitator } from './paysh-facilitator.js';

// ─── A2A Types (Google A2A spec) ──────────────────────────────────────────────

export interface A2AAgentCard {
  name: string;
  description: string;
  url: string;
  version: string;
  skills: A2ASkill[];
  /** x402/pay.sh/AP2 pricing extensions */
  pricing?: Record<string, {
    amount: string;
    asset: string;
    protocols: ('x402' | 'ap2' | 'mpp' | 'paysh')[];
    confidential?: boolean;
  }>;
  /** A2A auth methods supported */
  authentication?: {
    schemes: ('none' | 'bearer' | 'ed25519' | 'solana-wallet')[];
  };
}

export interface A2ASkill {
  id: string;
  name: string;
  description: string;
  inputModes?: string[];
  outputModes?: string[];
}

export interface A2ATaskInput {
  id?: string;
  skill: string;
  message: {
    role: 'user';
    parts: Array<{ type: 'text'; text: string } | { type: 'data'; data: Record<string, unknown> }>;
  };
  sessionId?: string;
  metadata?: Record<string, unknown>;
}

export interface A2ATaskStatus {
  state: 'submitted' | 'working' | 'completed' | 'failed' | 'cancelled';
  message?: {
    role: 'agent';
    parts: Array<{ type: 'text'; text: string } | { type: 'data'; data: Record<string, unknown> }>;
  };
  error?: { code: string; message: string };
}

export interface A2ATask {
  id: string;
  status: A2ATaskStatus;
  artifacts?: Array<{
    name: string;
    mimeType: string;
    parts: Array<{ type: 'text'; text: string }>;
  }>;
  /** Payment receipt when x402/AP2 was used */
  paymentReceipt?: {
    signature: string;
    amount: string;
    asset: string;
    protocol: string;
    timestamp: number;
  };
}

export type PaymentProtocol = 'x402' | 'ap2' | 'mpp' | 'paysh';

export interface A2AClientConfig {
  /** Base URL of the peer agent */
  agentUrl: string;
  /** Solana keypair for signing x402/AP2 payments */
  signer?: Keypair;
  /** Solana connection for on-chain payments */
  connection?: Connection;
  /** Preferred payment protocol */
  paymentProtocol?: PaymentProtocol;
  /** Use pay.sh blind relay for confidential payments */
  confidential?: boolean;
  /** Auto-pay without prompting (agent-mode) */
  autoPay?: boolean;
  /** Max USDC per request */
  maxAmountUsdc?: number;
  /** Request timeout ms */
  timeoutMs?: number;
}

// ─── A2A Client ───────────────────────────────────────────────────────────────

export class A2AClient {
  private readonly config: Required<A2AClientConfig>;
  private agentCard: A2AAgentCard | null = null;
  private paysh: PayshFacilitator | null = null;

  constructor(config: A2AClientConfig) {
    this.config = {
      agentUrl: config.agentUrl,
      signer: config.signer ?? (null as unknown as Keypair),
      connection: config.connection ?? (null as unknown as Connection),
      paymentProtocol: config.paymentProtocol ?? 'x402',
      confidential: config.confidential ?? false,
      autoPay: config.autoPay ?? false,
      maxAmountUsdc: config.maxAmountUsdc ?? 1.0,
      timeoutMs: config.timeoutMs ?? 30_000,
    };

    if (this.config.confidential && this.config.signer && this.config.connection) {
      this.paysh = new PayshFacilitator({
        connection: this.config.connection,
        signer: this.config.signer,
        useBlinding: true,
      });
    }
  }

  /** Fetch and cache the peer's A2A agent card */
  async discover(): Promise<A2AAgentCard> {
    if (this.agentCard) return this.agentCard;

    const url = `${this.config.agentUrl}/.well-known/agent.json`;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(this.config.timeoutMs),
      headers: {
        accept: 'application/json',
        'x-a2a-client': 'solana-clawd/1.7.0',
      },
    });

    if (!res.ok) throw new Error(`A2A discover failed: ${res.status} ${url}`);
    this.agentCard = (await res.json()) as A2AAgentCard;
    return this.agentCard;
  }

  /** Submit a task to the peer agent, paying via x402/AP2/pay.sh if required */
  async sendTask(input: A2ATaskInput): Promise<A2ATask> {
    const taskId = input.id ?? `clawd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const payload: A2ATaskInput = { ...input, id: taskId };

    const tasksUrl = `${this.config.agentUrl}/tasks`;
    const body = JSON.stringify(payload);

    if (this.config.confidential && this.paysh) {
      // Route through pay.sh blind relay
      const result = await this.paysh.fetch(tasksUrl, {
        method: 'POST',
        body,
        headers: { 'content-type': 'application/json' },
      }, {
        onPaymentRequired: this.config.autoPay
          ? undefined
          : async (req) => {
            const amountUsdc = Number(req.maxAmountRequired) / 1e6;
            if (amountUsdc > this.config.maxAmountUsdc) {
              throw new Error(`A2A payment too large: ${amountUsdc} USDC > ${this.config.maxAmountUsdc} limit`);
            }
            return true;
          },
      });

      const task = result.body as A2ATask;
      if (result.signature) {
        task.paymentReceipt = {
          signature: result.signature,
          amount: '?',
          asset: 'USDC',
          protocol: 'paysh',
          timestamp: Date.now(),
        };
      }
      return task;
    }

    // Standard x402 / AP2 / MPP path via clawdFetch
    if (!this.config.signer || !this.config.connection) {
      // No-payment path (public agent)
      const res = await fetch(tasksUrl, {
        method: 'POST',
        body,
        headers: { 'content-type': 'application/json' },
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });
      if (!res.ok && res.status !== 402) throw new Error(`A2A task failed: ${res.status}`);
      return (await res.json()) as A2ATask;
    }

    const fetchOpts: ClawdFetchOptions = {
      method: 'POST',
      body,
      headers: { 'content-type': 'application/json' },
      signer: this.config.signer,
      connection: this.config.connection,
      protocol: this.config.paymentProtocol === 'paysh' ? 'ap2' : this.config.paymentProtocol as 'x402' | 'mpp' | 'ap2',
      advertisePayer: !this.config.confidential,
      onPaymentRequired: this.config.autoPay
        ? undefined
        : async (req) => {
          const amountUsdc = Number(req.maxAmountRequired) / 1e6;
          if (amountUsdc > this.config.maxAmountUsdc) {
            throw new Error(`A2A payment too large: ${amountUsdc} USDC > ${this.config.maxAmountUsdc} limit`);
          }
          return true;
        },
    };

    const res = await clawdFetch(tasksUrl, fetchOpts);
    const task = (await res.json()) as A2ATask;

    if (res.signature) {
      task.paymentReceipt = {
        signature: res.signature,
        amount: '?',
        asset: 'USDC',
        protocol: this.config.paymentProtocol,
        timestamp: Date.now(),
      };
    }

    return task;
  }

  /** Poll for task completion */
  async getTask(taskId: string): Promise<A2ATask> {
    const url = `${this.config.agentUrl}/tasks/${taskId}`;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(this.config.timeoutMs),
      headers: { 'x-a2a-client': 'solana-clawd/1.7.0' },
    });
    if (!res.ok) throw new Error(`A2A getTask failed: ${res.status}`);
    return (await res.json()) as A2ATask;
  }

  /** Stream task updates via SSE */
  async *streamTask(taskId: string): AsyncGenerator<A2ATaskStatus> {
    const url = `${this.config.agentUrl}/tasks/${taskId}/subscribe`;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(120_000),
      headers: {
        accept: 'text/event-stream',
        'x-a2a-client': 'solana-clawd/1.7.0',
      },
    });
    if (!res.ok) throw new Error(`A2A stream failed: ${res.status}`);
    if (!res.body) throw new Error('A2A stream: no body');

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          try {
            const status = JSON.parse(line.slice(6)) as A2ATaskStatus;
            yield status;
            if (status.state === 'completed' || status.state === 'failed') return;
          } catch { /* skip malformed SSE */ }
        }
      }
    }
  }

  /** Convenience: send task and wait for completion */
  async runTask(input: A2ATaskInput): Promise<A2ATask> {
    const task = await this.sendTask(input);
    if (task.status.state === 'completed' || task.status.state === 'failed') {
      return task;
    }

    // Poll until done
    let attempts = 0;
    while (attempts < 60) {
      await new Promise(r => setTimeout(r, 2000));
      const updated = await this.getTask(task.id);
      if (updated.status.state === 'completed' || updated.status.state === 'failed') {
        return updated;
      }
      attempts++;
    }

    throw new Error(`A2A task ${task.id} timed out after 120s`);
  }
}

// ─── A2A Server Helpers ───────────────────────────────────────────────────────

/**
 * Build an A2A agent card for the HERMES x402 agent.
 * Serve this at GET /.well-known/agent.json
 */
export function buildHermesAgentCard(opts: {
  baseUrl: string;
  clawdPayTo: string;
  version?: string;
}): A2AAgentCard {
  return {
    name: 'HERMES x402',
    description: 'Private AI agent for Nous Research — Solana-native trading intelligence with x402 payment gating.',
    url: opts.baseUrl,
    version: opts.version ?? '1.7.0',
    skills: [
      {
        id: 'market-analyze',
        name: 'Market Analysis',
        description: 'Analyze a Solana token and return a trading signal with score and rationale.',
        inputModes: ['text', 'data'],
        outputModes: ['text', 'data'],
      },
      {
        id: 'ooda-cycle',
        name: 'OODA Loop Cycle',
        description: 'Run one full OODA trading cycle (Observe → Orient → Decide → Act → Learn).',
        inputModes: ['data'],
        outputModes: ['data'],
      },
      {
        id: 'wallet-brief',
        name: 'Wallet Brief',
        description: 'Summarize a Solana wallet: token holdings, recent trades, PnL estimate.',
        inputModes: ['data'],
        outputModes: ['text', 'data'],
      },
      {
        id: 'dark-defi',
        name: 'Dark DeFi Intelligence',
        description: 'Confidential on-chain analysis for whale detection and MEV pattern recognition.',
        inputModes: ['data'],
        outputModes: ['data'],
      },
    ],
    pricing: {
      'market-analyze': { amount: '500000', asset: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', protocols: ['x402', 'ap2', 'paysh'], confidential: true },
      'ooda-cycle': { amount: '1000000', asset: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', protocols: ['x402', 'paysh'] },
      'wallet-brief': { amount: '250000', asset: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', protocols: ['x402', 'mpp', 'ap2'] },
      'dark-defi': { amount: '5000000', asset: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', protocols: ['paysh'], confidential: true },
    },
    authentication: {
      schemes: ['solana-wallet', 'ed25519'],
    },
  };
}
