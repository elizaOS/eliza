/**
 * Transport and payload attestation interfaces for agent commerce.
 * This plugin performs policy checks and SHA-256 attestation — not encryption.
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
    [key: string]: unknown;
  };
  metadata?: {
    payloadHash?: string;
    actionType?: string;
    version?: string;
  };
}

export interface IStvorSession {
  sessionId: string;
  agentA: string;
  agentB: string;
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
  offMessage(callback: (msg: IStvorMessage) => Promise<void>): void;
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

export class NotImplementedError extends Error {
  constructor(method: string) {
    super(`${method} is not yet implemented. Use onMessage() for event-driven message handling.`);
    this.name = 'NotImplementedError';
  }
}
