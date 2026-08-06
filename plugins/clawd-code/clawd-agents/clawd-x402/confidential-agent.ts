/**
 * Confidential Agent — Private AI on Solana
 *
 * Wraps any AI inference call (Anthropic, Nous/HERMES, OpenAI)
 * with end-to-end payment privacy via:
 *
 *  • pay.sh blind relay (on-chain payment privacy)
 *  • x402 with AP2 mandate authorization
 *  • Encrypted request/response payloads (TweetNaCl box)
 *  • Solana wallet Ed25519 identity (no API keys, no KYC)
 *
 * This is the "private AI" component of the HERMES x402 stack.
 * The agent can transact on and off chain without revealing:
 *  - Its wallet address to the model provider
 *  - The model's identity to the resource server
 *  - The request content to the payment facilitator
 *
 * Sponsor: pay.sh + x402 + Nous Research + Solana
 */

import nacl from 'tweetnacl';
import bs58 from 'bs58';
import type { Connection, Keypair } from '@solana/web3.js';
import { PayshFacilitator } from './paysh-facilitator.js';
import { A2AClient } from './a2a-agent.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ConfidentialAgentConfig {
  /** Ed25519 keypair — used for Solana payments AND message encryption */
  signer: Keypair;
  /** Solana RPC connection */
  connection: Connection;
  /** Inference endpoint (Nous Research, OpenRouter, local Ollama, etc.) */
  inferenceEndpoint: string;
  /** Payment facilitator: 'paysh' (private) | 'x402' (transparent) */
  paymentFacilitator?: 'paysh' | 'x402';
  /** AP2 mandate JWT for delegated payment authorization */
  ap2Mandate?: string;
  /** Encrypt request body before sending (requires peer pubkey) */
  encryptRequests?: boolean;
  /** Peer's NaCl public key for request encryption */
  peerPublicKey?: Uint8Array;
  /** Max USDC per inference call */
  maxCostUsdc?: number;
}

export interface ConfidentialInferenceRequest {
  model: string;
  messages: Array<{ role: string; content: string }>;
  temperature?: number;
  maxTokens?: number;
  stream?: boolean;
  /** Attach on-chain context (wallet balance, token holdings) */
  onChainContext?: boolean;
}

export interface ConfidentialInferenceResult {
  content: string;
  model: string;
  /** Solana tx signature for the inference payment */
  paymentSignature?: string;
  /** pay.sh blind receipt — proves payment without linking wallet */
  blindReceipt?: string;
  /** Whether the request was sent encrypted */
  encrypted: boolean;
  /** Total cost in USDC */
  costUsdc?: number;
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
}

// ─── Confidential Agent ───────────────────────────────────────────────────────

export class ConfidentialAgent {
  private readonly config: Required<ConfidentialAgentConfig>;
  private readonly paysh: PayshFacilitator;
  private readonly naclKeypair: nacl.BoxKeyPair;

  constructor(config: ConfidentialAgentConfig) {
    this.config = {
      signer: config.signer,
      connection: config.connection,
      inferenceEndpoint: config.inferenceEndpoint,
      paymentFacilitator: config.paymentFacilitator ?? 'paysh',
      ap2Mandate: config.ap2Mandate ?? '',
      encryptRequests: config.encryptRequests ?? false,
      peerPublicKey: config.peerPublicKey ?? new Uint8Array(32),
      maxCostUsdc: config.maxCostUsdc ?? 2.0,
    };

    this.paysh = new PayshFacilitator({
      connection: this.config.connection,
      signer: this.config.signer,
      useBlinding: true,
    });

    // Derive NaCl X25519 keypair from Ed25519 secret for encryption
    // Note: converting Ed25519 to X25519 for box encryption
    this.naclKeypair = nacl.box.keyPair.fromSecretKey(
      this.config.signer.secretKey.slice(0, 32),
    );
  }

  /** Run a confidential inference call, paying automatically via pay.sh/x402 */
  async infer(request: ConfidentialInferenceRequest): Promise<ConfidentialInferenceResult> {
    const body = this.config.encryptRequests && this.config.peerPublicKey.some(b => b !== 0)
      ? this.encryptBody(JSON.stringify(this.buildPayload(request)))
      : JSON.stringify(this.buildPayload(request));

    const encrypted = this.config.encryptRequests && this.config.peerPublicKey.some(b => b !== 0);

    const contentType = encrypted
      ? 'application/octet-stream'
      : 'application/json';

    let result: ConfidentialInferenceResult;

    if (this.config.paymentFacilitator === 'paysh') {
      const payshResult = await this.paysh.fetch(
        this.config.inferenceEndpoint,
        { method: 'POST', body, headers: { 'content-type': contentType } },
        {
          ap2Mandate: this.config.ap2Mandate || undefined,
          onPaymentRequired: async (req) => {
            const cost = Number(req.maxAmountRequired) / 1e6;
            if (cost > this.config.maxCostUsdc) {
              throw new Error(`Inference cost ${cost} USDC exceeds limit ${this.config.maxCostUsdc}`);
            }
            return true;
          },
        },
      );

      const responseBody = encrypted && payshResult.body
        ? this.decryptBody(payshResult.body as string)
        : payshResult.body;

      result = this.parseResponse(responseBody, {
        paymentSignature: payshResult.signature,
        blindReceipt: payshResult.blindReceipt,
        encrypted,
      });
    } else {
      // x402 transparent path
      const { clawdFetch } = await import('./client-sdk.js');
      const res = await clawdFetch(this.config.inferenceEndpoint, {
        method: 'POST',
        body,
        headers: { 'content-type': contentType },
        signer: this.config.signer,
        connection: this.config.connection,
        protocol: 'x402',
        advertisePayer: true,
        onPaymentRequired: async (req) => {
          const cost = Number(req.maxAmountRequired) / 1e6;
          return cost <= this.config.maxCostUsdc;
        },
      });

      const responseBody = await res.json();
      result = this.parseResponse(responseBody, {
        paymentSignature: res.signature,
        encrypted,
      });
    }

    return result;
  }

  /** Connect to a peer agent via A2A and run a task confidentially */
  async runA2ATask(opts: {
    peerUrl: string;
    skill: string;
    message: string;
    data?: Record<string, unknown>;
  }): Promise<string> {
    const client = new A2AClient({
      agentUrl: opts.peerUrl,
      signer: this.config.signer,
      connection: this.config.connection,
      paymentProtocol: this.config.paymentFacilitator === 'paysh' ? 'paysh' : 'x402',
      confidential: this.config.paymentFacilitator === 'paysh',
      autoPay: true,
      maxAmountUsdc: this.config.maxCostUsdc,
    });

    const task = await client.runTask({
      skill: opts.skill,
      message: {
        role: 'user',
        parts: [
          { type: 'text', text: opts.message },
          ...(opts.data ? [{ type: 'data' as const, data: opts.data }] : []),
        ],
      },
    });

    if (task.status.state === 'failed') {
      throw new Error(`A2A task failed: ${task.status.error?.message}`);
    }

    const textPart = task.status.message?.parts.find(p => p.type === 'text') as
      | { type: 'text'; text: string }
      | undefined;
    return textPart?.text ?? JSON.stringify(task.artifacts ?? task.status);
  }

  /** Sign a message with the agent's Ed25519 keypair (Solana-compatible) */
  sign(message: Uint8Array): Uint8Array {
    return nacl.sign.detached(message, this.config.signer.secretKey);
  }

  /** Verify a peer's signature */
  verify(message: Uint8Array, signature: Uint8Array, peerPubkey: Uint8Array): boolean {
    return nacl.sign.detached.verify(message, signature, peerPubkey);
  }

  // ─── Private helpers ────────────────────────────────────────────────────────

  private buildPayload(req: ConfidentialInferenceRequest) {
    return {
      model: req.model,
      messages: req.messages,
      temperature: req.temperature ?? 0.7,
      max_tokens: req.maxTokens ?? 2048,
      stream: false,
    };
  }

  private encryptBody(plaintext: string): string {
    const nonce = nacl.randomBytes(nacl.box.nonceLength);
    const encrypted = nacl.box(
      new TextEncoder().encode(plaintext),
      nonce,
      this.config.peerPublicKey,
      this.naclKeypair.secretKey,
    );
    // Encode as base64: nonce || ciphertext
    const combined = new Uint8Array(nonce.length + encrypted.length);
    combined.set(nonce);
    combined.set(encrypted, nonce.length);
    return Buffer.from(combined).toString('base64');
  }

  private decryptBody(ciphertextB64: string): unknown {
    try {
      const combined = Buffer.from(ciphertextB64, 'base64');
      const nonce = combined.slice(0, nacl.box.nonceLength);
      const ciphertext = combined.slice(nacl.box.nonceLength);
      const decrypted = nacl.box.open(ciphertext, nonce, this.config.peerPublicKey, this.naclKeypair.secretKey);
      if (!decrypted) throw new Error('decrypt failed');
      return JSON.parse(new TextDecoder().decode(decrypted));
    } catch {
      return ciphertextB64;
    }
  }

  private parseResponse(
    body: unknown,
    meta: { paymentSignature?: string; blindReceipt?: string; encrypted: boolean },
  ): ConfidentialInferenceResult {
    const b = body as Record<string, unknown>;
    const choices = b['choices'] as Array<{ message?: { content?: string }; text?: string }> | undefined;
    const content = choices?.[0]?.message?.content ?? choices?.[0]?.text ?? String(body ?? '');
    const usage = b['usage'] as { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | undefined;
    const model = (b['model'] as string | undefined) ?? 'unknown';

    return {
      content,
      model,
      paymentSignature: meta.paymentSignature,
      blindReceipt: meta.blindReceipt,
      encrypted: meta.encrypted,
      usage: usage
        ? {
          promptTokens: usage.prompt_tokens ?? 0,
          completionTokens: usage.completion_tokens ?? 0,
          totalTokens: usage.total_tokens ?? 0,
        }
        : undefined,
    };
  }
}
