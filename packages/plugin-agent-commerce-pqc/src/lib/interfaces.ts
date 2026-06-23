/**
 * @file Stvor SDK Integration Interfaces (Plugin-local copy)
 * 
 * Type definitions for secure agent-to-agent communication.
 */

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
  getStatus(): Promise<{
    connected: boolean;
    agentId: string;
    relayUrl: string;
    activeSessions: number;
    messagesReceived: number;
    messagesSent: number;
  }>;
}

export interface IPayloadHasher {
  hashPayload(data: unknown): string;
  verifyHash(data: unknown, hash: string): boolean;
}

export interface PqcKeyPair {
  ek: string;
  dk: string;
}

export interface HybridKeyPair {
  ik: { public_key: string; private_key: string };
  spk: { public_key: string; private_key: string };
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