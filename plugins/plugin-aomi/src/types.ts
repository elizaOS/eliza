/**
 * Shared room-bound outcome and pending-operation contracts for the Aomi service, action, and provider.
 */
import type {
  SendResult,
  Session,
  WalletRequest,
  WalletRequestResult,
} from "@aomi-labs/client";

export interface AomiSession {
  readonly sessionId: string;
  send(message: string): Promise<SendResult>;
  resolve(id: string, result: WalletRequestResult): Promise<void>;
  reject(id: string, reason?: string): Promise<void>;
  close(): void;
  getPendingRequests(): WalletRequest[];
  syncRuntimeOptions(options: {
    app: string;
    applicationId?: string | null;
    apiKey?: string;
    clientId?: string;
    userState?: Record<string, unknown>;
  }): void;
  on(
    event: "wallet_requests_changed",
    handler: (requests: WalletRequest[]) => void,
  ): () => void;
}

export type AomiSessionFactory = (
  options: ConstructorParameters<typeof Session>[0],
  sessionOptions: ConstructorParameters<typeof Session>[1],
) => AomiSession;

export type AomiBoundary =
  | {
      readonly status: "completed";
      readonly result: SendResult;
    }
  | {
      readonly status: "wallet_required";
      readonly request: WalletRequest;
      readonly preview: string;
    };

export interface AomiPendingOperation {
  readonly request: WalletRequest;
  readonly preview: string;
  readonly executionReady: boolean;
}
