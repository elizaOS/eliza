// @ts-nocheck — Mixin pattern: each `withFoo()` returns a class that calls
// methods belonging to sibling mixins (e.g. `this.recordScreenTimeEvent`).
// Type checking each mixin in isolation surfaces 700+ phantom errors because
// the local TBase constraint can't see sibling mixin methods. Real type
// safety is enforced at the composed-service level (LifeOpsService class).
// Refactoring requires either declaration-merging every cross-mixin method
// or moving to a single composed interface — tracked as separate work.
import fs from "node:fs";
import path from "node:path";
import { resolveDefaultAgentWorkspaceDir } from "@elizaos/agent/providers/workspace";
import { whatsappAuthExists } from "@elizaos/agent/services/whatsapp-pairing";
import type { Plugin } from "@elizaos/core";
import type { LifeOpsWhatsAppConnectorStatus } from "@elizaos/shared/contracts/lifeops";
import { sendWhatsAppMessageWithRuntimeService } from "./runtime-service-delegates.js";
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

type RuntimeWithPluginLifecycle = {
  getPluginOwnership?: (pluginName: string) => { plugin: Plugin } | null;
  registerPlugin?: (plugin: Plugin) => Promise<void>;
  reloadPlugin?: (plugin: Plugin) => Promise<void>;
};

type WhatsAppRuntimeServiceLike = {
  connected?: boolean;
  phoneNumber?: string | null;
  sendMessage?: (message: {
    accountId?: string;
    type: "text";
    to: string;
    content: string;
    replyToMessageId?: string;
  }) => Promise<{ messages?: Array<{ id?: string }> }>;
};

type LocalWhatsAppAuthState = {
  authDir: string;
  registered: boolean | null;
};

function readLocalWhatsAppAuthState(
  authDir: string,
): LocalWhatsAppAuthState | null {
  const credsPath = path.join(authDir, "creds.json");
  if (!fs.existsSync(credsPath)) {
    return null;
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(credsPath, "utf8")) as unknown;
    if (parsed && typeof parsed === "object" && "registered" in parsed) {
      const registered = (parsed as { registered?: unknown }).registered;
      return {
        authDir,
        registered: typeof registered === "boolean" ? registered : null,
      };
    }
    return { authDir, registered: null };
  } catch {
    return { authDir, registered: false };
  }
}

function localWhatsAppAuthState(): LocalWhatsAppAuthState | null {
  const workspaceDir = resolveDefaultAgentWorkspaceDir();
  const lifeOpsAuth = readLocalWhatsAppAuthState(
    path.join(workspaceDir, "lifeops-whatsapp-auth", "default"),
  );
  if (lifeOpsAuth) return lifeOpsAuth;

  if (whatsappAuthExists(workspaceDir, "default")) {
    return readLocalWhatsAppAuthState(
      path.join(workspaceDir, "whatsapp-auth", "default"),
    );
  }

  return null;
}

function getWhatsAppRuntimeService(
  runtime: Constructor<LifeOpsServiceBase>["prototype"]["runtime"],
): WhatsAppRuntimeServiceLike | null {
  const service = runtime.getService(
    "whatsapp",
  ) as WhatsAppRuntimeServiceLike | null;
  return service && typeof service === "object" ? service : null;
}

function setWhatsAppRuntimeEnv(authDir: string): void {
  process.env.WHATSAPP_AUTH_DIR = authDir;
}

async function ensureWhatsAppPluginLoaded(
  runtime: Constructor<LifeOpsServiceBase>["prototype"]["runtime"],
): Promise<boolean> {
  const runtimeWithLifecycle = runtime as typeof runtime &
    RuntimeWithPluginLifecycle;
  if (
    typeof runtimeWithLifecycle.registerPlugin !== "function" &&
    typeof runtimeWithLifecycle.reloadPlugin !== "function"
  ) {
    return false;
  }

  const mod = await import("@elizaos/plugin-whatsapp");
  const plugin = (mod.default ?? (mod as { plugin?: Plugin }).plugin) as
    | Plugin
    | undefined;
  if (!plugin) {
    return false;
  }

  const existingOwnership =
    typeof runtimeWithLifecycle.getPluginOwnership === "function"
      ? runtimeWithLifecycle.getPluginOwnership("whatsapp")
      : null;
  if (
    existingOwnership &&
    typeof runtimeWithLifecycle.reloadPlugin === "function"
  ) {
    await runtimeWithLifecycle.reloadPlugin(plugin);
    return true;
  }

  if (typeof runtimeWithLifecycle.registerPlugin === "function") {
    await runtimeWithLifecycle.registerPlugin(plugin);
    return true;
  }

  return false;
}

function messageIdFromWhatsAppResponse(result: {
  messages?: Array<{ id?: string }>;
}): string | null {
  const id = result.messages?.[0]?.id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

/** @internal */
export function withWhatsApp<TBase extends Constructor<LifeOpsServiceBase>>(
  Base: TBase,
) {
  class LifeOpsWhatsAppServiceMixin extends Base {
    async getWhatsAppConnectorStatus(): Promise<LifeOpsWhatsAppConnectorStatus> {
      const creds = readWhatsAppCredentialsFromEnv();
      const hasCloudCredentials = creds !== null;
      const localAuth = localWhatsAppAuthState();
      const authDir = localAuth?.authDir ?? null;
      const hasLocalAuth = localAuth !== null;
      const localAuthReady = Boolean(
        localAuth && localAuth.registered !== false,
      );
      let pluginLoadError: string | null = null;

      if (authDir && localAuthReady) {
        setWhatsAppRuntimeEnv(authDir);
        this.runtime.setSetting?.("WHATSAPP_AUTH_DIR", authDir, false);
        if (!getWhatsAppRuntimeService(this.runtime)) {
          try {
            await ensureWhatsAppPluginLoaded(this.runtime);
          } catch (error) {
            pluginLoadError =
              error instanceof Error ? error.message : String(error);
          }
        }
      }

      const runtimeService =
        authDir && localAuthReady
          ? getWhatsAppRuntimeService(this.runtime)
          : null;
      const serviceConnected = Boolean(runtimeService?.connected);
      const localOutboundReady = Boolean(
        runtimeService?.sendMessage && serviceConnected,
      );
      const outboundReady = hasCloudCredentials || localOutboundReady;
      const inboundReady = hasCloudCredentials || serviceConnected;
      const status: LifeOpsWhatsAppConnectorStatus = {
        provider: "whatsapp",
        connected: outboundReady || inboundReady,
        inbound: true,
        ...(creds?.phoneNumberId ? { phoneNumberId: creds.phoneNumberId } : {}),
        ...(runtimeService?.phoneNumber
          ? { phoneNumber: runtimeService.phoneNumber }
          : {}),
        localAuthAvailable: hasLocalAuth,
        localAuthRegistered: localAuth?.registered ?? null,
        serviceConnected,
        outboundReady,
        inboundReady,
        transport: hasCloudCredentials
          ? "cloudapi"
          : hasLocalAuth
            ? "baileys"
            : "unconfigured",
        lastCheckedAt: new Date().toISOString(),
      };

      const degradations: NonNullable<
        LifeOpsWhatsAppConnectorStatus["degradations"]
      > = [];
      if (localAuth?.registered === false) {
        degradations.push({
          axis: "delivery-degraded",
          code: "local_auth_unregistered",
          message:
            "WhatsApp local credentials are present, but Baileys marks the session unregistered. Re-pair WhatsApp locally before send/receive can work.",
          retryable: true,
        });
      } else if (!outboundReady && hasLocalAuth) {
        degradations.push({
          axis: "delivery-degraded",
          code: "local_runtime_unavailable",
          message:
            "WhatsApp local auth is present, but the local WhatsApp runtime send service is not ready yet.",
          retryable: true,
        });
      }
      if (pluginLoadError) {
        degradations.push({
          axis: "delivery-degraded",
          code: "local_runtime_unavailable",
          message: pluginLoadError,
          retryable: true,
        });
      }
      if (degradations.length > 0) {
        status.degradations = degradations;
      }

      return status;
    }

    async sendWhatsAppMessage(
      req: WhatsAppSendRequest,
    ): Promise<{ ok: true; messageId: string }> {
      const delegated = await sendWhatsAppMessageWithRuntimeService({
        runtime: this.runtime,
        request: req,
      });
      if (delegated.status === "handled") {
        return delegated.value;
      }
      if (delegated.error) {
        this.logLifeOpsWarn(
          "runtime_service_delegation_fallback",
          delegated.reason,
          {
            provider: "whatsapp",
            operation: "message.send",
            error:
              delegated.error instanceof Error
                ? delegated.error.message
                : String(delegated.error),
          },
        );
      }

      const creds = readWhatsAppCredentialsFromEnv();
      if (creds) {
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

      const localAuth = localWhatsAppAuthState();
      const authDir =
        localAuth && localAuth.registered !== false ? localAuth.authDir : null;
      if (authDir) {
        setWhatsAppRuntimeEnv(authDir);
        this.runtime.setSetting?.("WHATSAPP_AUTH_DIR", authDir, false);
        let runtimeService = getWhatsAppRuntimeService(this.runtime);
        if (!runtimeService?.sendMessage) {
          await ensureWhatsAppPluginLoaded(this.runtime);
          runtimeService = getWhatsAppRuntimeService(this.runtime);
        }

        if (runtimeService?.sendMessage) {
          const result = await runtimeService.sendMessage({
            accountId: "default",
            type: "text",
            to: req.to,
            content: req.text,
            ...(req.replyToMessageId
              ? { replyToMessageId: req.replyToMessageId }
              : {}),
          });
          const messageId = messageIdFromWhatsAppResponse(result);
          if (!messageId) {
            fail(502, "WhatsApp local send did not return a message id.");
          }
          return { ok: true, messageId };
        }
      }

      fail(
        400,
        "WhatsApp is not configured. Pair WhatsApp locally or set ELIZA_WHATSAPP_ACCESS_TOKEN and ELIZA_WHATSAPP_PHONE_NUMBER_ID.",
      );
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
