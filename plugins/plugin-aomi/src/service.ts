/**
 * Owns room-isolated Aomi sessions and pauses each turn at completion or a wallet boundary.
 *
 * A submitted wallet result is retained until Aomi acknowledges it, making a
 * failed callback retry safe from duplicate broadcasts.
 */
import {
  type SendResult,
  Session,
  type WalletRequest,
  type WalletRequestResult,
} from "@aomi-labs/client";
import { ElizaError, type IAgentRuntime, Service } from "@elizaos/core";
import {
  WALLET_BACKEND_SERVICE_TYPE,
  type WalletBackendService,
} from "@elizaos/plugin-wallet";
import { type AomiConfig, readAomiConfig } from "./config.js";
import type {
  AomiBoundary,
  AomiPendingOperation,
  AomiSession,
  AomiSessionFactory,
} from "./types.js";
import {
  executeWalletRequest,
  walletRequestPreview,
  walletRequestSupportError,
} from "./wallet.js";

export const AOMI_SERVICE_TYPE = "aomi" as const;

interface PendingState {
  readonly request: WalletRequest;
  readonly preview: string;
  execution?: WalletRequestResult;
}

interface RoomConversation {
  readonly session: AomiSession;
  completion?: Promise<SendResult>;
  pending?: PendingState;
}

export interface AomiServiceDependencies {
  readonly createSession: AomiSessionFactory;
  readonly executeWallet: (
    runtime: IAgentRuntime,
    config: AomiConfig,
    request: WalletRequest,
  ) => Promise<WalletRequestResult>;
}

export interface AomiServiceStatus {
  readonly apiUrl: string;
  readonly app: string;
  readonly walletReady: boolean;
  readonly evmAddress: string | null;
  readonly solanaAddress: string | null;
  readonly pending: AomiPendingOperation | null;
}

const defaultDependencies: AomiServiceDependencies = {
  createSession: (options, sessionOptions) =>
    new Session(options, sessionOptions),
  executeWallet: executeWalletRequest,
};

export class AomiService extends Service {
  static override serviceType = AOMI_SERVICE_TYPE;

  override capabilityDescription =
    "Room-isolated Aomi on-chain agent sessions with confirmed wallet execution";

  readonly aomiConfig: AomiConfig;

  private readonly conversations = new Map<string, RoomConversation>();

  constructor(
    runtime?: IAgentRuntime,
    aomiConfig?: AomiConfig,
    private readonly dependencies: AomiServiceDependencies = defaultDependencies,
  ) {
    super(runtime);
    if (aomiConfig) {
      this.aomiConfig = aomiConfig;
    } else if (runtime) {
      this.aomiConfig = readAomiConfig(runtime);
    } else {
      throw new ElizaError(
        "AomiService requires an Eliza runtime when no explicit configuration is supplied.",
        {
          code: "AOMI_RUNTIME_REQUIRED",
          severity: "fatal",
        },
      );
    }
  }

  static override async start(runtime: IAgentRuntime): Promise<AomiService> {
    return new AomiService(runtime, readAomiConfig(runtime));
  }

  async submit(roomId: string, prompt: string): Promise<AomiBoundary> {
    const normalizedPrompt = prompt.trim();
    if (!normalizedPrompt) {
      throw new ElizaError("Aomi requires a non-empty request.", {
        code: "AOMI_EMPTY_PROMPT",
        severity: "fatal",
      });
    }

    const conversation = this.conversation(roomId);
    if (conversation.completion || conversation.pending) {
      throw new ElizaError(
        "This room already has an Aomi operation awaiting completion.",
        {
          code: "AOMI_ROOM_BUSY",
          context: { roomId },
          severity: "ephemeral",
        },
      );
    }

    conversation.session.syncRuntimeOptions({
      app: this.aomiConfig.app,
      applicationId: this.aomiConfig.applicationId,
      apiKey: this.aomiConfig.apiKey,
      userState: this.walletUserState(),
    });
    conversation.completion = conversation.session.send(normalizedPrompt);
    return this.waitForBoundary(roomId, conversation);
  }

  async confirm(roomId: string): Promise<AomiBoundary> {
    const conversation = this.requiredConversation(roomId);
    const pending = conversation.pending;
    if (!pending) {
      throw new ElizaError("No Aomi wallet request is awaiting confirmation.", {
        code: "AOMI_NO_PENDING_WALLET_REQUEST",
        context: { roomId },
        severity: "ephemeral",
      });
    }

    if (!pending.execution) {
      pending.execution = await this.dependencies.executeWallet(
        this.runtime,
        this.aomiConfig,
        pending.request,
      );
    }
    await conversation.session.resolve(pending.request.id, pending.execution);
    conversation.pending = undefined;
    return this.waitForBoundary(roomId, conversation);
  }

  async reject(
    roomId: string,
    reason = "User rejected the wallet request.",
  ): Promise<AomiBoundary> {
    const conversation = this.requiredConversation(roomId);
    const pending = conversation.pending;
    if (!pending) {
      throw new ElizaError("No Aomi wallet request is awaiting rejection.", {
        code: "AOMI_NO_PENDING_WALLET_REQUEST",
        context: { roomId },
        severity: "ephemeral",
      });
    }
    await conversation.session.reject(pending.request.id, reason);
    conversation.pending = undefined;
    return this.waitForBoundary(roomId, conversation);
  }

  pending(roomId: string): AomiPendingOperation | null {
    const pending = this.conversations.get(roomId)?.pending;
    return pending
      ? {
          request: pending.request,
          preview: pending.preview,
          executionReady: pending.execution !== undefined,
        }
      : null;
  }

  status(roomId: string): AomiServiceStatus {
    const backend = this.runtime
      .getService<WalletBackendService>(WALLET_BACKEND_SERVICE_TYPE)
      ?.getWalletBackendOrNull();
    const addresses = backend?.getAddresses();
    return {
      apiUrl: this.aomiConfig.apiUrl,
      app: this.aomiConfig.app,
      walletReady: Boolean(addresses?.evm || addresses?.solana),
      evmAddress: addresses?.evm ?? null,
      solanaAddress: addresses?.solana?.toBase58() ?? null,
      pending: this.pending(roomId),
    };
  }

  override async stop(): Promise<void> {
    for (const conversation of this.conversations.values()) {
      conversation.session.close();
    }
    this.conversations.clear();
  }

  private conversation(roomId: string): RoomConversation {
    const existing = this.conversations.get(roomId);
    if (existing) return existing;

    const session = this.dependencies.createSession(
      {
        baseUrl: this.aomiConfig.apiUrl,
        apiKey: this.aomiConfig.apiKey,
        logger: {
          debug: (...args: unknown[]) =>
            this.runtime.logger.debug({ roomId, args }, "[AomiService] client"),
        },
      },
      {
        app: this.aomiConfig.app,
        applicationId: this.aomiConfig.applicationId,
        apiKey: this.aomiConfig.apiKey,
        clientType: "elizaos",
        userState: this.walletUserState(),
      },
    );
    const conversation = { session };
    this.conversations.set(roomId, conversation);
    return conversation;
  }

  private requiredConversation(roomId: string): RoomConversation {
    const conversation = this.conversations.get(roomId);
    if (!conversation) {
      throw new ElizaError("No Aomi session exists for this room.", {
        code: "AOMI_SESSION_NOT_FOUND",
        context: { roomId },
        severity: "ephemeral",
      });
    }
    return conversation;
  }

  private walletUserState(): Record<string, unknown> {
    const backend = this.runtime
      .getService<WalletBackendService>(WALLET_BACKEND_SERVICE_TYPE)
      ?.getWalletBackendOrNull();
    const addresses = backend?.getAddresses();
    const connected = Boolean(addresses?.evm || addresses?.solana);
    return {
      connection: { is_connected: connected },
      ...(addresses?.evm
        ? {
            evm: {
              address: addresses.evm,
              chain_id: this.aomiConfig.chainId,
              aa: { mode: "none" },
            },
          }
        : {}),
      ...(addresses?.solana
        ? {
            svm: {
              address: addresses.solana.toBase58(),
              cluster: this.solanaCluster(),
              capabilities: [
                "solana:signTransaction",
                "solana:signMessage",
                "solana:signAndSendTransaction",
              ],
            },
          }
        : {}),
      ext: { client_type: "elizaos" },
    };
  }

  private solanaCluster(): string {
    const configured = this.runtime.getSetting("SOLANA_CLUSTER");
    return typeof configured === "string" && configured.trim()
      ? configured.trim()
      : "solana:mainnet";
  }

  private async waitForBoundary(
    roomId: string,
    conversation: RoomConversation,
  ): Promise<AomiBoundary> {
    const completion = conversation.completion;
    if (!completion) {
      throw new ElizaError("Aomi room has no active completion promise.", {
        code: "AOMI_SESSION_INVARIANT",
        context: { roomId },
        severity: "fatal",
      });
    }

    const existing = conversation.session.getPendingRequests()[0];
    const boundary = existing
      ? { kind: "wallet" as const, request: existing }
      : await new Promise<
          | { readonly kind: "completed"; readonly result: SendResult }
          | { readonly kind: "wallet"; readonly request: WalletRequest }
        >((resolve, reject) => {
          let settled = false;
          let unsubscribe: () => void = () => undefined;
          const settle = (
            value:
              | { readonly kind: "completed"; readonly result: SendResult }
              | { readonly kind: "wallet"; readonly request: WalletRequest },
          ) => {
            if (settled) return;
            settled = true;
            unsubscribe();
            resolve(value);
          };
          unsubscribe = conversation.session.on(
            "wallet_requests_changed",
            (requests) => {
              if (requests[0]) settle({ kind: "wallet", request: requests[0] });
            },
          );
          completion.then(
            (result) => settle({ kind: "completed", result }),
            (cause) => {
              if (settled) return;
              settled = true;
              unsubscribe();
              conversation.completion = undefined;
              conversation.pending = undefined;
              reject(
                new ElizaError("Aomi did not complete the delegated request.", {
                  code: "AOMI_REQUEST_FAILED",
                  context: { roomId },
                  cause,
                  severity: "ephemeral",
                }),
              );
            },
          );
        });

    if (boundary.kind === "completed") {
      conversation.completion = undefined;
      conversation.pending = undefined;
      return { status: "completed", result: boundary.result };
    }

    const unsupported = walletRequestSupportError(boundary.request);
    if (unsupported) {
      await conversation.session.reject(boundary.request.id, unsupported);
      return this.waitForBoundary(roomId, conversation);
    }

    const preview = walletRequestPreview(boundary.request);
    conversation.pending = { request: boundary.request, preview };
    return { status: "wallet_required", request: boundary.request, preview };
  }
}
