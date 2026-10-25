/**
 * Telegram delivery adapter for sensitive requests (secret / OAuth). Mirrors the
 * Discord DM adapter: when a secret or OAuth value is needed, the user is DM'd a
 * single tap-through button to a secure entry / consent page rather than ever
 * typing the value into the chat transport.
 *
 * The link itself is supplied by the request envelope (`callback.url` /
 * `delivery.linkBaseUrl`), which the secrets/oauth feature populates in a
 * deployment-aware way (a Cloud-hosted authenticated link when Eliza Cloud is
 * linked, otherwise the local dashboard URL). This adapter just renders whatever
 * URL it is handed; it does not decide cloud-vs-local.
 *
 * Both this adapter and the Discord DM adapter register under the "dm" target;
 * the dispatch registry keeps every adapter per target and selects the right one
 * per request via `resolve(target, channelId, runtime)` + this adapter's
 * `supportsChannel`, so loading both connectors does not collide on "dm"
 * (registration order is irrelevant). See `dispatch-registry.ts`.
 */

import {
  type DeliveryResult,
  type DispatchSensitiveRequest,
  type IAgentRuntime,
  logger,
  type SensitiveRequest,
  type SensitiveRequestDeliveryAdapter,
} from "@elizaos/core";
import { Markup } from "telegraf";
import { TELEGRAM_SERVICE_NAME } from "./constants";

type TelegramDispatchRequest = DispatchSensitiveRequest &
  Partial<SensitiveRequest>;

const SENSITIVE_REQUEST_DISPATCH_REGISTRY_SERVICE_NAME =
  "SensitiveRequestDispatchRegistry";

interface TelegramBotLike {
  telegram: {
    sendMessage: (
      chatId: number,
      text: string,
      extra?: Record<string, unknown>,
    ) => Promise<unknown>;
  };
}

function getTelegramBot(runtime: IAgentRuntime): TelegramBotLike | null {
  const svc = runtime.getService?.(TELEGRAM_SERVICE_NAME) as
    | { bot?: unknown }
    | null
    | undefined;
  const bot =
    svc && typeof svc === "object" && "bot" in svc
      ? (svc as { bot?: unknown }).bot
      : null;
  if (bot && typeof bot === "object" && "telegram" in bot) {
    return bot as TelegramBotLike;
  }
  return null;
}

function resolveLink(request: TelegramDispatchRequest): string | undefined {
  return request.callback?.url ?? request.delivery?.linkBaseUrl ?? undefined;
}

function buildDmText(request: TelegramDispatchRequest, link?: string): string {
  const reason = request.delivery?.reason ?? "A sensitive value is required.";
  const lines = ["A sensitive value is needed to continue.", reason];
  if (!link) {
    lines.push(
      request.delivery?.instruction ??
        "Please open the Eliza app to provide this value.",
    );
  }
  if (request.expiresAt)
    lines.push(`This request expires at ${request.expiresAt}.`);
  return lines.join("\n");
}

async function deliverViaTelegramDm(args: {
  request: DispatchSensitiveRequest;
  channelId?: string;
  runtime: unknown;
}): Promise<DeliveryResult> {
  const runtime = args.runtime as IAgentRuntime;
  const request = args.request as TelegramDispatchRequest;
  const candidate =
    args.channelId ?? request.requesterEntityId ?? request.originUserId;
  const chatId = typeof candidate === "string" ? Number(candidate) : Number.NaN;
  if (!Number.isFinite(chatId) || chatId <= 0) {
    return {
      delivered: false,
      target: "dm",
      error:
        "No Telegram user id available (need targetChannelId or originUserId)",
    };
  }

  const bot = getTelegramBot(runtime);
  if (!bot) {
    return {
      delivered: false,
      target: "dm",
      error: "Telegram service unavailable",
    };
  }

  const link = resolveLink(request);
  const text = buildDmText(request, link);
  const provider =
    typeof request.provider === "string" ? request.provider : "account";
  const label =
    request.kind === "oauth" ? `Connect ${provider}` : "Provide securely";

  try {
    await bot.telegram.sendMessage(
      chatId,
      text,
      link
        ? {
            reply_markup: Markup.inlineKeyboard([
              Markup.button.url(label, link),
            ]).reply_markup,
          }
        : undefined,
    );
    return {
      delivered: true,
      target: "dm",
      channelId: String(chatId),
      url: link,
      expiresAt: request.expiresAt,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(
      { src: "telegram:sensitive-request-adapter", err: message },
      "Failed to deliver sensitive request DM",
    );
    return { delivered: false, target: "dm", error: message };
  }
}

export const telegramDmSensitiveRequestAdapter: SensitiveRequestDeliveryAdapter =
  {
    target: "dm",
    supportsChannel: (_channelId, runtime) =>
      Boolean(getTelegramBot(runtime as IAgentRuntime)),
    deliver: (args) => deliverViaTelegramDm(args),
  };

interface DispatchRegistryLike {
  register: (adapter: SensitiveRequestDeliveryAdapter) => void;
}

/**
 * Register the Telegram DM adapter into the runtime's
 * SensitiveRequestDispatchRegistry, if one is available. Safe to call multiple
 * times and from any plugin lifecycle hook; never throws.
 */
export function registerTelegramDmSensitiveRequestAdapter(
  runtime: IAgentRuntime,
): void {
  const tryRegister = (): boolean => {
    const registry = runtime.getService?.(
      SENSITIVE_REQUEST_DISPATCH_REGISTRY_SERVICE_NAME,
    ) as unknown as DispatchRegistryLike | null | undefined;
    if (!registry || typeof registry.register !== "function") return false;
    try {
      registry.register(telegramDmSensitiveRequestAdapter);
      return true;
    } catch (err) {
      logger.warn(
        {
          src: "telegram:sensitive-request-adapter",
          err: err instanceof Error ? err.message : String(err),
        },
        "Failed to register Telegram DM adapter with SensitiveRequestDispatchRegistry",
      );
      return true;
    }
  };

  if (tryRegister()) return;
  setImmediate(() => {
    tryRegister();
  });
}
