import {
  type IAgentRuntime,
  type ITokenDataService,
  type IWalletService,
  Service,
  ServiceType,
} from "@elizaos/core";
import { registerDefaultWalletChainHandlers } from "../chains/registry.js";
import { validateWalletGovParams } from "../chains/evm/gov-router.js";
import type {
  WalletChainHandler,
  WalletChainHandlerMetadata,
  WalletRouterContext,
  WalletRouterFailure,
  WalletRouterParams,
  WalletRouterResult,
  WalletRouterSubaction,
} from "../types/wallet-router.js";
import { normalizeWalletChainKey } from "../types/wallet-router.js";
import type { WalletBackend } from "../wallet/backend.js";
import { resolveWalletBackend } from "../wallet/select-backend.js";
import "../core-augmentation.js";

export const WALLET_BACKEND_SERVICE_TYPE = "wallet-backend" as const;

/**
 * Runtime service exposing {@link WalletBackend}. Retrieve via
 * `runtime.getService("wallet-backend")`.
 */
export class WalletBackendService extends Service {
  static override serviceType = WALLET_BACKEND_SERVICE_TYPE;

  override capabilityDescription =
    "Unified wallet backend and chain router (EVM + Solana, local or Steward)";

  private backend: WalletBackend | null = null;
  private backendLoadError: unknown = null;
  private readonly handlers = new Map<string, WalletChainHandler>();
  private readonly aliases = new Map<string, string>();

  static override async start(
    runtime: IAgentRuntime,
  ): Promise<WalletBackendService> {
    const svc = new WalletBackendService(runtime);
    try {
      svc.backend = await resolveWalletBackend(runtime);
    } catch (error) {
      svc.backend = null;
      svc.backendLoadError = error;
      runtime.logger.warn(
        {
          error: error instanceof Error ? error.message : String(error),
        },
        "Wallet backend unavailable; wallet router will expose metadata and dry-run only until signing is configured",
      );
    }
    registerDefaultWalletChainHandlers(svc, runtime);
    return svc;
  }

  getWalletBackend(): WalletBackend {
    if (!this.backend) {
      if (this.backendLoadError instanceof Error) {
        throw this.backendLoadError;
      }
      throw new Error("Wallet backend is not configured");
    }
    return this.backend;
  }

  getWalletBackendOrNull(): WalletBackend | null {
    return this.backend;
  }

  registerChainHandler(handler: WalletChainHandler): void {
    const key = normalizeWalletChainKey(handler.chain);
    this.handlers.set(key, handler);

    const aliases = new Set<string>([
      handler.chain,
      handler.chainId,
      handler.name,
      ...handler.aliases,
    ]);
    for (const alias of aliases) {
      this.aliases.set(normalizeWalletChainKey(alias), key);
    }
  }

  listChainHandlers(): WalletChainHandlerMetadata[] {
    return [...this.handlers.values()].map((handler) =>
      this.toMetadata(handler),
    );
  }

  listChainHandlersForSubaction(
    subaction: WalletRouterSubaction,
  ): WalletChainHandlerMetadata[] {
    return [...this.handlers.values()]
      .filter((handler) => handler.supportedActions.includes(subaction))
      .map((handler) => this.toMetadata(handler));
  }

  getCapabilities(): {
    readonly chains: readonly WalletChainHandlerMetadata[];
  } {
    return {
      chains: this.listChainHandlers(),
    };
  }

  async routeWalletAction(
    params: WalletRouterParams,
  ): Promise<WalletRouterResult> {
    const handlerResult = this.resolveHandler(params);
    if (!handlerResult.ok) {
      return handlerResult;
    }

    const { handler } = handlerResult;
    const required = this.validateRequiredParams(params);
    if (required) {
      return required;
    }

    if (params.dryRun || params.mode === "prepare") {
      if (
        params.dryRun &&
        (!handler.dryRun.supported ||
          !handler.dryRun.supportedActions.includes(params.subaction))
      ) {
        return {
          ok: false,
          error: "DRY_RUN_UNSUPPORTED",
          detail: `${handler.name} does not support dry-run for ${params.subaction}.`,
        };
      }

      if (params.subaction === "gov") {
        try {
          const result = await handler.execute(params, this.createContext());
          return {
            ok: true,
            handler: this.toMetadata(handler),
            result,
          };
        } catch (error) {
          return {
            ok: false,
            error: "EXECUTION_FAILED",
            detail: error instanceof Error ? error.message : String(error),
          };
        }
      }

      return {
        ok: true,
        handler: this.toMetadata(handler),
        result: {
          status: "prepared",
          chain: handler.chain,
          chainId: handler.chainId,
          subaction: params.subaction,
          dryRun: params.dryRun,
          mode: params.mode,
          amount: params.amount,
          fromToken: params.fromToken,
          toToken: params.toToken,
          to: params.recipient,
          metadata: {
            signer: handler.signer,
            dryRun: handler.dryRun,
            supportedActions: handler.supportedActions,
            tokens: handler.tokens,
          },
        },
      };
    }

    try {
      const result = await handler.execute(params, this.createContext());
      return {
        ok: true,
        handler: this.toMetadata(handler),
        result,
      };
    } catch (error) {
      return {
        ok: false,
        error: "EXECUTION_FAILED",
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }

  override async stop(): Promise<void> {
    // No persistent connections for local / Steward HTTP clients today.
  }

  private resolveHandler(
    params: WalletRouterParams,
  ):
    | { readonly ok: true; readonly handler: WalletChainHandler }
    | WalletRouterFailure {
    if (params.chain) {
      const alias = this.aliases.get(normalizeWalletChainKey(params.chain));
      const handler = alias ? this.handlers.get(alias) : null;
      if (!handler) {
        return {
          ok: false,
          error: "UNSUPPORTED_CHAIN",
          detail: `Unsupported wallet chain "${params.chain}".`,
          candidates: this.listChainHandlers(),
        };
      }
      if (!handler.supportedActions.includes(params.subaction)) {
        return {
          ok: false,
          error: "UNSUPPORTED_SUBACTION",
          detail: `${handler.name} does not support ${params.subaction}.`,
          candidates: [this.toMetadata(handler)],
        };
      }
      return { ok: true, handler };
    }

    const candidates = [...this.handlers.values()].filter((handler) =>
      handler.supportedActions.includes(params.subaction),
    );
    if (candidates.length === 0) {
      return {
        ok: false,
        error: "UNSUPPORTED_SUBACTION",
        detail: `No wallet chain supports ${params.subaction}.`,
      };
    }
    if (candidates.length > 1) {
      return {
        ok: false,
        error: "AMBIGUOUS_CHAIN",
        detail: `Choose a chain for wallet ${params.subaction}.`,
        candidates: candidates.map((handler) => this.toMetadata(handler)),
      };
    }

    const handler = candidates[0];
    return { ok: true, handler };
  }

  private validateRequiredParams(
    params: WalletRouterParams,
  ): WalletRouterFailure | null {
    if (params.subaction === "gov") {
      const detail = validateWalletGovParams(params);
      return detail
        ? {
            ok: false,
            error: "INVALID_PARAMS",
            detail,
          }
        : null;
    }

    if (!params.amount) {
      return {
        ok: false,
        error: "INVALID_PARAMS",
        detail: "amount is required.",
      };
    }
    if (params.subaction === "transfer" && !params.recipient) {
      return {
        ok: false,
        error: "INVALID_PARAMS",
        detail: "recipient is required for transfer.",
      };
    }
    if (params.subaction === "swap") {
      if (!params.fromToken) {
        return {
          ok: false,
          error: "INVALID_PARAMS",
          detail: "fromToken is required for swap.",
        };
      }
      if (!params.toToken) {
        return {
          ok: false,
          error: "INVALID_PARAMS",
          detail: "toToken is required for swap.",
        };
      }
    }
    return null;
  }

  private createContext(): WalletRouterContext {
    return {
      runtime: this.runtime,
      walletBackend: this.backend,
      walletServices: this.getWalletServices(),
      tokenDataService: this.getTokenDataService(),
    };
  }

  private getWalletServices(): IWalletService[] {
    const runtime = this.runtime as IAgentRuntime & {
      getServicesByType?: <T>(serviceName: string) => T[];
    };
    if (typeof runtime.getServicesByType !== "function") {
      return [];
    }
    return runtime.getServicesByType<IWalletService>(ServiceType.WALLET);
  }

  private getTokenDataService(): ITokenDataService | null {
    return this.runtime.getService<ITokenDataService>(ServiceType.TOKEN_DATA);
  }

  private toMetadata(handler: WalletChainHandler): WalletChainHandlerMetadata {
    return {
      chainId: handler.chainId,
      chain: handler.chain,
      name: handler.name,
      aliases: [...handler.aliases],
      supportedActions: [...handler.supportedActions],
      tokens: handler.tokens.map((token) => ({ ...token })),
      signer: { ...handler.signer },
      dryRun: {
        ...handler.dryRun,
        supportedActions: [...handler.dryRun.supportedActions],
      },
    };
  }
}
