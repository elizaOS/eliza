// @ts-nocheck — mixin: type safety is enforced on the composed class
import fs from "node:fs";
import path from "node:path";
import type { LifeOpsWhatsAppConnectorStatus } from "@elizaos/shared/contracts/lifeops";
import type { Constructor, LifeOpsServiceBase } from "./service-mixin-core.js";
import { fail } from "./service-normalize.js";
import {
  drainWhatsAppInboundBuffer,
  parseAndBufferWhatsAppWebhookMessages,
  peekWhatsAppInboundBuffer,
  readWhatsAppCredentialsFromEnv,
  sendWhatsAppMessage as sendWhatsAppMessageRequest,
  WhatsAppError,
  type WhatsAppMessage,
  type WhatsAppSendRequest,
} from "./whatsapp-client.js";

type ConnectorSetupServiceLike = {
  getConfig(): Record<string, unknown>;
  getWorkspaceDir?: () => string;
};

type WhatsAppRuntimeServiceLike = {
  connected?: boolean;
  phoneNumber?: string | null;
  config?: {
    transport?: "baileys" | "cloudapi";
    authDir?: string;
    phoneNumberId?: string;
  } | null;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function readRuntimeSetting(
  runtime: Constructor<LifeOpsServiceBase>["prototype"]["runtime"],
  key: string,
): string | null {
  const getter = runtime as typeof runtime & {
    getSetting?: (settingKey: string) => unknown;
  };
  return (
    nonEmptyString(getter.getSetting?.(key)) ?? nonEmptyString(process.env[key])
  );
}

function getConnectorSetupService(
  runtime: Constructor<LifeOpsServiceBase>["prototype"]["runtime"],
): ConnectorSetupServiceLike | null {
  const service = runtime.getService("connector-setup");
  if (!service || typeof service !== "object") {
    return null;
  }
  const candidate = service as ConnectorSetupServiceLike;
  return typeof candidate.getConfig === "function" ? candidate : null;
}

function readWhatsAppConfigAuthDir(
  config: Record<string, unknown>,
): string | null {
  const connectors = asRecord(config.connectors);
  const whatsapp = asRecord(connectors?.whatsapp);
  if (!whatsapp) {
    return null;
  }

  const directAuthDir =
    nonEmptyString(whatsapp.authDir) ?? nonEmptyString(whatsapp.sessionPath);
  if (directAuthDir) {
    return directAuthDir;
  }

  const accounts = asRecord(whatsapp.accounts);
  if (!accounts) {
    return null;
  }

  for (const account of Object.values(accounts)) {
    const accountConfig = asRecord(account);
    if (!accountConfig || accountConfig.enabled === false) {
      continue;
    }
    const accountAuthDir =
      nonEmptyString(accountConfig.authDir) ??
      nonEmptyString(accountConfig.sessionPath);
    if (accountAuthDir) {
      return accountAuthDir;
    }
  }

  return null;
}

function whatsappAuthExists(authDir: string | null): boolean {
  if (!authDir) {
    return false;
  }
  return fs.existsSync(path.join(authDir, "creds.json"));
}

function resolveWhatsAppLocalAuthDir(args: {
  runtime: Constructor<LifeOpsServiceBase>["prototype"]["runtime"];
  setupService: ConnectorSetupServiceLike | null;
  whatsappService: WhatsAppRuntimeServiceLike | null;
}): string | null {
  const serviceAuthDir = nonEmptyString(args.whatsappService?.config?.authDir);
  if (serviceAuthDir) {
    return serviceAuthDir;
  }

  const settingAuthDir =
    readRuntimeSetting(args.runtime, "WHATSAPP_AUTH_DIR") ??
    readRuntimeSetting(args.runtime, "WHATSAPP_SESSION_PATH") ??
    readRuntimeSetting(args.runtime, "ELIZA_WHATSAPP_SESSION_PATH");
  if (settingAuthDir) {
    return settingAuthDir;
  }

  const configAuthDir = args.setupService
    ? readWhatsAppConfigAuthDir(args.setupService.getConfig())
    : null;
  if (configAuthDir) {
    return configAuthDir;
  }

  const workspaceDir = args.setupService?.getWorkspaceDir?.();
  return workspaceDir
    ? path.join(workspaceDir, "whatsapp-auth", "default")
    : null;
}

/** @internal */
export function withWhatsApp<TBase extends Constructor<LifeOpsServiceBase>>(
  Base: TBase,
) {
  class LifeOpsWhatsAppServiceMixin extends Base {
    async getWhatsAppConnectorStatus(): Promise<LifeOpsWhatsAppConnectorStatus> {
      const creds = readWhatsAppCredentialsFromEnv();
      const whatsappService = this.runtime.getService(
        "whatsapp",
      ) as WhatsAppRuntimeServiceLike | null;
      const setupService = getConnectorSetupService(this.runtime);
      const localAuthDir = resolveWhatsAppLocalAuthDir({
        runtime: this.runtime,
        setupService,
        whatsappService,
      });
      const localAuthExists = whatsappAuthExists(localAuthDir);
      const serviceConnected = Boolean(whatsappService?.connected);
      return {
        provider: "whatsapp",
        connected: creds !== null || localAuthExists || serviceConnected,
        inbound: true,
        ...(creds?.phoneNumberId ? { phoneNumberId: creds.phoneNumberId } : {}),
        lastCheckedAt: new Date().toISOString(),
      };
    }

    async sendWhatsAppMessage(
      req: WhatsAppSendRequest,
    ): Promise<{ ok: true; messageId: string }> {
      const creds = readWhatsAppCredentialsFromEnv();
      if (!creds) {
        fail(
          400,
          "WhatsApp is not configured. Set ELIZA_WHATSAPP_ACCESS_TOKEN and ELIZA_WHATSAPP_PHONE_NUMBER_ID.",
        );
      }
      try {
        return await sendWhatsAppMessageRequest(creds, req);
      } catch (error) {
        if (error instanceof WhatsAppError) {
          fail(
            error.status >= 400 && error.status < 600 ? error.status : 502,
            error.message,
          );
        }
        throw error;
      }
    }

    async ingestWhatsAppWebhook(
      payload: unknown,
    ): Promise<{ ingested: number; messages: WhatsAppMessage[] }> {
      // Buffer messages for periodic drain via syncWhatsAppInbound.
      const messages = parseAndBufferWhatsAppWebhookMessages(payload);
      return { ingested: messages.length, messages };
    }

    /**
     * Drain buffered inbound WhatsApp messages.
     *
     * WhatsApp Business Cloud API has no "list messages" endpoint — all inbound
     * messages arrive via webhook push. This method drains the in-process buffer
     * that {@link ingestWhatsAppWebhook} populates, giving callers periodic-pull
     * semantics on top of the push-only transport.
     *
     * Deduplication is performed by message ID inside the buffer, so calling
     * this method multiple times within one webhook cycle will not double-ingest.
     *
     * Returns the drained messages. Callers are responsible for writing them to
     * memory or any downstream store.
     */
    syncWhatsAppInbound(): { drained: number; messages: WhatsAppMessage[] } {
      const messages = drainWhatsAppInboundBuffer();
      return { drained: messages.length, messages };
    }

    /**
     * Return the current set of buffered inbound WhatsApp messages without
     * clearing the buffer (peek semantics).
     *
     * Use this for periodic inspection — e.g. to surface recent messages to
     * the agent without consuming them from the buffer.  Messages are
     * deduplicated by ID inside the buffer, so repeated calls return the
     * same set until the buffer is drained by {@link syncWhatsAppInbound}.
     *
     * Mirrors the webhook-parser shape: every returned message has the same
     * {@link WhatsAppMessage} structure as those produced by
     * {@link ingestWhatsAppWebhook}.
     *
     * @param limit Maximum number of messages to return (newest first). Default: 25.
     */
    pullWhatsAppRecent(limit = 25): {
      count: number;
      messages: WhatsAppMessage[];
    } {
      const clampedLimit = Math.min(Math.max(1, Math.floor(limit)), 500);
      const all = peekWhatsAppInboundBuffer();
      // Buffer is insertion-ordered (Map preserves insertion order); return
      // the most recently inserted messages by taking from the tail.
      const recent = all.slice(-clampedLimit);
      return { count: recent.length, messages: recent };
    }
  }

  return LifeOpsWhatsAppServiceMixin;
}
