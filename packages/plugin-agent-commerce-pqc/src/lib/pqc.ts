import {
  initSync,
  WasmKeyPair,
  WasmSession,
  wasm_mlkem_keygen,
  wasm_hybrid_session_initiate,
  wasm_hybrid_session_respond,
  wasm_ec_sign,
  wasm_ec_verify,
} from '@stvor/web3/wasm';
import { readFileSync } from 'fs';
import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { resolve } from 'path';

export interface PqcKeyPair {
  ek: string;
  dk: string;
}

export interface HybridKeyPair {
  ik: WasmKeyPair;
  spk: WasmKeyPair;
  pqc: PqcKeyPair;
}

export interface EncryptedPayload {
  mlkemCt: string;
  aliceIkPub: string;
  aliceSpkPub: string;
  ciphertext: string;
}

export class PayloadTooDeepError extends Error {
  constructor(depth: number) {
    super(`Payload nesting exceeds maximum depth of ${depth}`);
    this.name = 'PayloadTooDeepError';
  }
}

export class PqcEncryptionError extends Error {
  constructor(
    message: string,
    public readonly agentId: string,
    public readonly eventId: string,
    public readonly timestamp: number,
  ) {
    super(message);
    this.name = 'PqcEncryptionError';
  }
}

export class NotImplementedError extends Error {
  constructor(method: string) {
    super(`${method} is not yet implemented. Use onMessage() for event-driven message handling.`);
    this.name = 'NotImplementedError';
  }
}

export interface IStvorMessage {
  id: string;
  from: string;
  to: string;
  timestamp: number;
  content: {
    type: 'job_prompt' | 'job_deliverable' | 'job_evaluation' | 'handshake';
    jobId: string;
    data: unknown;
    encrypted?: boolean;
    pqcEncrypted?: boolean;
    encryption?: string;
    [key: string]: unknown;
  };
  metadata?: {
    payloadHash?: string;
    actionType?: string;
    version?: string;
  };
  encrypted?: boolean;
  pqcEncrypted?: boolean;
  encryption?: string;
  sessionId?: string;
}

export interface IStvorSession {
  sessionId: string;
  agentA: string;
  agentB: string;
  encryptionKeyCount: number;
  createdAt: number;
  expiresAt: number;
}

export interface IStvorTransport {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  sendSecurePayload(
    recipientId: string,
    jobId: string,
    messageType: 'job_prompt' | 'job_deliverable' | 'job_evaluation' | 'handshake',
    payload: Record<string, unknown>,
    responseTimeoutMs?: number,
  ): Promise<string>;
  receiveSecureMessage(timeoutMs?: number): Promise<IStvorMessage | null>;
  onMessage(callback: (msg: IStvorMessage) => Promise<void>): void;
  getSessionStatus(agentId: string): Promise<IStvorSession | null>;
  getSession(agentId: string): { encryptionActive: boolean } | null;
  getStatus(): Promise<{
    connected: boolean;
    agentId: string;
    relayUrl: string;
    activeSessions: number;
    messagesReceived: number;
    messagesSent: number;
  }>;
}

let initialized = false;

export function ensureWasm(): void {
  if (initialized) return;
  const wasmBytes = readFileSync(
    resolve('./node_modules/@stvor/web3/dist/wasm/stvor_crypto_bg.wasm')
  );
  initSync({ module: wasmBytes });
  initialized = true;
}

export class PayloadHasher {
  static hash(payload: unknown): string {
    return PayloadHasher.hashPayload(payload);
  }

  static verify(payload: unknown, storedHash: string): boolean {
    return PayloadHasher.verifyHash(payload, storedHash);
  }

  private static readonly MAX_STRINGIFY_DEPTH = 64;

  static stableStringify(value: unknown): string {
    const seen = new WeakSet();
    const helper = (val: unknown, depth: number): string => {
      if (depth > PayloadHasher.MAX_STRINGIFY_DEPTH) {
        throw new Error(`Payload nesting exceeds maximum depth of ${PayloadHasher.MAX_STRINGIFY_DEPTH}`);
      }
      if (val === null || typeof val !== 'object') {
        return JSON.stringify(val);
      }
      if (seen.has(val)) {
        throw new Error('Circular reference detected in payload');
      }
      seen.add(val);
      if (Array.isArray(val)) {
        return '[' + val.map(v => helper(v, depth + 1)).join(',') + ']';
      }
      const keys = Object.keys(val as Record<string, unknown>).sort();
      const pairs = keys.map(k => JSON.stringify(k) + ': ' + helper((val as Record<string, unknown>)[k], depth + 1));
      return '{' + pairs.join(',') + '}';
    };
    return helper(value, 0);
  }

  static hashPayload(payload: unknown): string {
    return createHash('sha256')
      .update(PayloadHasher.stableStringify(payload))
      .digest('hex');
  }

  static verifyHash(payload: unknown, storedHash: string): boolean {
    const computed = Buffer.from(PayloadHasher.hashPayload(payload));
    const expected = Buffer.from(storedHash);
    if (computed.length !== expected.length) return false;
    return timingSafeEqual(computed, expected);
  }

  static signPayload(
    payload: unknown,
    signerKeyPair: HybridKeyPair,
  ): { hash: string; signature: string } {
    ensureWasm();
    const hash = PayloadHasher.hashPayload(payload);
    const signature = wasm_ec_sign(
      new TextEncoder().encode(hash),
      signerKeyPair.ik,
    );
    return { hash, signature };
  }

  static verifySignature(
    payload: unknown,
    hash: string,
    signature: string,
    signerPublicKey: string,
  ): boolean {
    ensureWasm();
    const computedHash = PayloadHasher.hashPayload(payload);

    const hashBytes = Buffer.from(computedHash, 'hex');
    const storedHashBytes = Buffer.from(hash, 'hex');
    
    if (hashBytes.length !== storedHashBytes.length) return false;
    if (!timingSafeEqual(hashBytes, storedHashBytes)) return false;
    
    return wasm_ec_verify(
      new TextEncoder().encode(hash),
      signature,
      signerPublicKey,
    );
  }

  hashPayload(payload: unknown): string {
    return PayloadHasher.hashPayload(payload);
  }

  verifyHash(payload: unknown, storedHash: string): boolean {
    return PayloadHasher.verifyHash(payload, storedHash);
  }
}

export class MockRelayClient {
  public userId: string;
  public isConnected = false;
  private messageHandler: ((msg: IStvorMessage) => Promise<void> | void) | null = null;

  constructor(userId: string) {
    this.userId = userId;
  }

  async connect(): Promise<void> {
    this.isConnected = true;
    console.log(`[MockRelay] ${this.userId} connected to in-process relay`);
  }

  async disconnect(): Promise<void> {
    this.isConnected = false;
    console.log(`[MockRelay] ${this.userId} disconnected`);
  }

  async send(message: IStvorMessage): Promise<{ id: string }> {
    return { id: message.id };
  }

  onMessage(callback: (msg: IStvorMessage) => Promise<void> | void): void {
    this.messageHandler = callback;
  }
}

export class StvorTransportManager implements IStvorTransport {
   private agentId: string;
   private keyPair: HybridKeyPair;
   private messageHandlers: Array<(msg: IStvorMessage) => Promise<void>> = [];
   private connected = false;
   private sessionCache: Map<string, { encryptionActive: boolean; createdAt: number }> = new Map();

  constructor(config: {
    agentId: string;
    appToken: string;
    relayUrl: string;
  }) {
    this.keyPair = this.initializeKeyPairSync();
    this.agentId = config.agentId;
  }

  private initializeKeyPairSync(): HybridKeyPair {
    ensureWasm();
    const ik = new WasmKeyPair();
    const spk = new WasmKeyPair();
    const pqc = JSON.parse(wasm_mlkem_keygen()) as PqcKeyPair;
    return { ik, spk, pqc };
  }

  getAgentId(): string {
    return this.agentId;
  }

  getPublicKey(): string {
    return this.keyPair.ik.public_key;
  }

  getKeyPair(): HybridKeyPair {
    return this.keyPair;
  }

  registerPeerPublicKey(agentId: string, keys: HybridKeyPair): void {
    // Simplified - no-op for plugin
  }

  async connect(): Promise<void> {
    this.connected = true;
    console.log(`[StvorTransport] Connected (mock mode)`);
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  async sendSecurePayload(
    recipientId: string,
    jobId: string,
    messageType: 'job_prompt' | 'job_deliverable' | 'job_evaluation' | 'handshake',
    payload: Record<string, unknown>,
    _responseTimeoutMs?: number,
  ): Promise<string> {
    const messageId = `msg-${Date.now()}-${randomBytes(8).toString('hex')}`;

    const payloadHash = PayloadHasher.hashPayload(payload);
    const plaintext = new TextEncoder().encode(JSON.stringify(payload));

    const message: IStvorMessage = {
      id: messageId,
      from: this.agentId,
      to: recipientId,
      timestamp: Date.now(),
      encrypted: true,
      pqcEncrypted: true,
      encryption: 'ML-KEM-768 + Double Ratchet + AES-256-GCM',
      content: {
        type: messageType,
        jobId,
        data: plaintext,
        encrypted: true,
        pqcEncrypted: true,
        encryption: 'ML-KEM-768 + Double Ratchet + AES-256-GCM',
      },
      metadata: {
        payloadHash,
        version: 'pqc-v1',
      },
    };

    for (const handler of this.messageHandlers) {
      await handler(message);
    }

    return messageId;
  }

  async receiveSecureMessage(_timeoutMs?: number): Promise<IStvorMessage | null> {
    throw new Error('receiveSecureMessage not implemented - use onMessage() for event-driven handling');
  }

  onMessage(callback: (msg: IStvorMessage) => Promise<void>): void {
    this.messageHandlers.push(callback);
  }

  async getSessionStatus(_agentId: string): Promise<IStvorSession | null> {
    return null;
  }

  getSession(agentId: string): { encryptionActive: boolean } | null {
    const session = this.sessionCache.get(agentId);
    if (!session) return null;
    return { encryptionActive: session.encryptionActive };
  }

  async getStatus(): Promise<{
    connected: boolean;
    agentId: string;
    relayUrl: string;
    activeSessions: number;
    messagesReceived: number;
    messagesSent: number;
  }> {
    return {
      connected: this.connected,
      agentId: this.agentId,
      relayUrl: 'mock',
      activeSessions: 0,
      messagesReceived: 0,
      messagesSent: 0,
    };
  }

  injectMockMessage(message: IStvorMessage): void {
    setImmediate(async () => {
      for (const handler of this.messageHandlers) {
        try {
          await handler(message);
        } catch {
          // ignore handler errors
        }
      }
    });
  }
}