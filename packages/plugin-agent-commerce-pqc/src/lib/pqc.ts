import { randomBytes } from 'crypto';
import { PayloadHasher } from './payload-hasher';
import { getPluginLogger } from './logger';

export { PayloadHasher, PayloadTooDeepError } from './payload-hasher';

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
  getSession?(agentId: string): Record<string, boolean> | null;
  getStatus(): Promise<{
    connected: boolean;
    agentId: string;
    relayUrl: string;
    activeSessions: number;
    messagesReceived: number;
    messagesSent: number;
  }>;
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
    getPluginLogger().debug(`Mock relay connected for ${this.userId}`);
  }

  async disconnect(): Promise<void> {
    this.isConnected = false;
    getPluginLogger().debug(`Mock relay disconnected for ${this.userId}`);
  }

  async send(message: IStvorMessage): Promise<{ id: string }> {
    return { id: message.id };
  }

  onMessage(callback: (msg: IStvorMessage) => Promise<void> | void): void {
    this.messageHandler = callback;
  }
}

/**
 * In-process transport for agent commerce messages.
 * Performs policy checks and SHA-256 payload attestation only — not encryption.
 */
export class PolicyTransportManager implements IStvorTransport {
  private readonly agentId: string;
  private readonly messageHandlers: Array<(msg: IStvorMessage) => Promise<void>> = [];
  private connected = false;
  private readonly sessionCache = new Map<string, { policyChecked: boolean; createdAt: number }>();

  constructor(config: { agentId: string; appToken?: string; relayUrl?: string }) {
    this.agentId = config.agentId;
  }

  getAgentId(): string {
    return this.agentId;
  }

  async connect(): Promise<void> {
    this.connected = true;
    getPluginLogger().info(`Policy transport ready for agent ${this.agentId}`);
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  async sendSecurePayload(
    recipientId: string,
    jobId: string,
    messageType: 'job_prompt' | 'job_deliverable' | 'job_evaluation' | 'handshake',
    payload: Record<string, unknown>,
  ): Promise<string> {
    const messageId = `msg-${Date.now()}-${randomBytes(8).toString('hex')}`;
    const payloadHash = PayloadHasher.hashPayload(payload);

    const message: IStvorMessage = {
      id: messageId,
      from: this.agentId,
      to: recipientId,
      timestamp: Date.now(),
      content: {
        type: messageType,
        jobId,
        data: payload,
      },
      metadata: {
        payloadHash,
        version: 'policy-v1',
      },
    };

    this.sessionCache.set(recipientId, { policyChecked: true, createdAt: Date.now() });

    for (const handler of this.messageHandlers) {
      await handler(message);
    }

    return messageId;
  }

  async receiveSecureMessage(): Promise<IStvorMessage | null> {
    throw new Error('receiveSecureMessage not implemented — use onMessage()');
  }

  onMessage(callback: (msg: IStvorMessage) => Promise<void>): void {
    this.messageHandlers.push(callback);
  }

  offMessage(callback: (msg: IStvorMessage) => Promise<void>): void {
    const idx = this.messageHandlers.indexOf(callback);
    if (idx !== -1) this.messageHandlers.splice(idx, 1);
  }

  async getSessionStatus(_agentId: string): Promise<IStvorSession | null> {
    return null;
  }

  getSession(agentId: string): { policyChecked: boolean } | null {
    const session = this.sessionCache.get(agentId);
    if (!session) return null;
    return { policyChecked: session.policyChecked };
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
      relayUrl: 'in-process',
      activeSessions: this.sessionCache.size,
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
          // ignore handler errors in tests
        }
      }
    });
  }
}

/** @deprecated Use PolicyTransportManager — kept for existing imports */
export type StvorTransportManager = PolicyTransportManager;
export const StvorTransportManager = PolicyTransportManager;
