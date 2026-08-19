/**
 * Exposes deterministic scenario actions over production gateway boundaries.
 * Network calls terminate at an in-process HTTP recorder, so results prove
 * request/auth/idempotency/domain contracts but never provider delivery.
 */

import crypto from "node:crypto";
import type {
  IAgentRuntime,
  Plugin,
  RouteRequest,
  RouteResponse,
} from "@elizaos/core";
import { BlueBubblesClient } from "../../../../../plugins/plugin-bluebubbles/src/client.ts";
import { blueBubblesDataRoutes } from "../../../../../plugins/plugin-bluebubbles/src/data-routes.ts";
import { verifyBlueBubblesWebhookSecret } from "../../../../../plugins/plugin-bluebubbles/src/webhook-auth.ts";
import {
  sendTwilioSms,
  sendTwilioVoiceCall,
} from "../../../../../plugins/plugin-phone/src/twilio.ts";
import { resolveTwilioCallParticipants } from "../../../../cloud/api/v1/twilio/voice/lib/twilio-call-direction.ts";
import { buildRealtimeVoiceTwiML } from "../../../../cloud/api/v1/twilio/voice/lib/twilio-voice-twiml.ts";
import { handleDiscordEventWebhook } from "../../../../cloud/services/gateway-discord/src/discord-event-webhook.ts";
import { postManagedAgentMessageWithRetry } from "../../../../cloud/services/gateway-discord/src/managed-message-egress.ts";
import { telegramAdapter } from "../../../../cloud/services/gateway-webhook/src/adapters/telegram.ts";
import { twilioAdapter } from "../../../../cloud/services/gateway-webhook/src/adapters/twilio.ts";
import type {
  PlatformAdapter,
  WebhookConfig,
} from "../../../../cloud/services/gateway-webhook/src/adapters/types.ts";
import { whatsappAdapter } from "../../../../cloud/services/gateway-webhook/src/adapters/whatsapp.ts";
import { calculateTwilioSmsBilling } from "../../../../cloud/services/gateway-webhook/src/billing.ts";
import type { GatewayRedis } from "../../../../cloud/services/gateway-webhook/src/redis.ts";
import { handleWebhook } from "../../../../cloud/services/gateway-webhook/src/webhook-handler.ts";

type JsonObject = Record<string, unknown>;

const TWILIO_CREDENTIALS = {
  accountSid: "AC_scenario",
  authToken: "scenario_auth_token",
  fromPhoneNumber: "+15555550000",
};

function options(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("gateway contract options must be an object");
  }
  return value as JsonObject;
}

function requiredString(value: JsonObject, key: string): string {
  const candidate = value[key];
  if (typeof candidate !== "string" || !candidate.trim()) {
    throw new TypeError(`${key} must be a non-empty string`);
  }
  return candidate;
}

function requiredNumber(value: JsonObject, key: string): number {
  const candidate = value[key];
  if (typeof candidate !== "number" || !Number.isFinite(candidate)) {
    throw new TypeError(`${key} must be a finite number`);
  }
  return candidate;
}

async function withFetchRecorder<T>(
  responseBody: JsonObject,
  run: () => Promise<T>,
): Promise<{
  result: T;
  requests: Array<{ url: string; init?: RequestInit }>;
}> {
  const original = globalThis.fetch;
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    requests.push({
      url:
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url,
      ...(init ? { init } : {}),
    });
    return Response.json(responseBody, { status: 201 });
  }) as typeof fetch;
  try {
    return { result: await run(), requests };
  } finally {
    globalThis.fetch = original;
  }
}

function adapterFor(platform: string): {
  adapter: PlatformAdapter;
  body: string;
  config: WebhookConfig;
  request: Request;
} {
  if (platform === "telegram") {
    const body = JSON.stringify({
      update_id: 7331,
      message: {
        message_id: 91,
        date: 1_786_957_200,
        chat: { id: 444, type: "private" },
        from: { id: 444, first_name: "Taylor" },
        text: "route this Telegram DM to my agent",
      },
    });
    return {
      adapter: telegramAdapter,
      body,
      config: { botToken: "bot-token", webhookSecret: "telegram-secret" },
      request: new Request("https://gateway.test/webhook/project/telegram", {
        method: "POST",
        headers: { "x-telegram-bot-api-secret-token": "telegram-secret" },
        body,
      }),
    };
  }
  if (platform === "whatsapp") {
    const body = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [
        {
          id: "business-1",
          changes: [
            {
              field: "messages",
              value: {
                messaging_product: "whatsapp",
                metadata: {
                  display_phone_number: "+15550000000",
                  phone_number_id: "phone-1",
                },
                contacts: [
                  { profile: { name: "Taylor" }, wa_id: "15551112222" },
                ],
                messages: [
                  {
                    id: "wamid-91",
                    from: "15551112222",
                    timestamp: "1786957200",
                    type: "text",
                    text: { body: "route this WhatsApp DM to my agent" },
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    const secret = "whatsapp-secret";
    const signature = crypto
      .createHmac("sha256", secret)
      .update(body)
      .digest("hex");
    return {
      adapter: whatsappAdapter,
      body,
      config: {
        appSecret: secret,
        accessToken: "access",
        phoneNumberId: "phone-1",
      },
      request: new Request("https://gateway.test/webhook/project/whatsapp", {
        method: "POST",
        headers: { "x-hub-signature-256": `sha256=${signature}` },
        body,
      }),
    };
  }
  if (platform === "twilio") {
    const params = new URLSearchParams({
      MessageSid: "SM_inbound_91",
      AccountSid: "AC_scenario",
      From: "+15551112222",
      To: "+15555550000",
      Body: "route this signed SMS to my agent",
      ProfileName: "Taylor",
    });
    const body = params.toString();
    const url = "https://gateway.test/webhook/project/twilio";
    const signature = crypto
      .createHmac("sha1", "twilio-auth-token")
      .update(
        `${url}${[...params.keys()]
          .sort()
          .map((key) => `${key}${params.get(key)}`)
          .join("")}`,
      )
      .digest("base64");
    return {
      adapter: twilioAdapter,
      body,
      config: {
        authToken: "twilio-auth-token",
        accountSid: "AC_scenario",
        phoneNumber: "+15555550000",
      },
      request: new Request(url, {
        method: "POST",
        headers: { "x-twilio-signature": signature },
        body,
      }),
    };
  }
  throw new Error(`unsupported ingress platform: ${platform}`);
}

class ScenarioGatewayRedis implements GatewayRedis {
  readonly store = new Map<string, string>();
  async get<T = unknown>(key: string): Promise<T | null> {
    const value = this.store.get(key);
    if (value === undefined) return null;
    try {
      return JSON.parse(value) as T;
    } catch {
      return value as T;
    }
  }
  async set(
    key: string,
    value: string,
    config: { nx?: boolean } = {},
  ): Promise<unknown> {
    if (config.nx && this.store.has(key)) return null;
    this.store.set(key, value);
    return "OK";
  }
  async del(key: string): Promise<unknown> {
    return this.store.delete(key) ? 1 : 0;
  }
  async lpush(): Promise<unknown> {
    return 1;
  }
  async ltrim(): Promise<unknown> {
    return "OK";
  }
  async expire(): Promise<unknown> {
    return 1;
  }
}

async function waitForCount(
  read: () => number,
  expected: number,
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < 2_000) {
    if (read() >= expected) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${expected} gateway effect(s)`);
}

export interface GatewayContractHarness {
  plugin: Plugin;
  dispatches: Array<JsonObject>;
  reset(): void;
}

let singleton: GatewayContractHarness | undefined;

export function createGatewayContractHarness(): GatewayContractHarness {
  if (singleton) return singleton;
  const dispatches: Array<JsonObject> = [];
  const seen = new Set<string>();
  const drafts = new Map<string, JsonObject>();
  const routeRedis = new ScenarioGatewayRedis();

  const plugin: Plugin = {
    name: "gateway-deterministic-contract",
    description:
      "Deterministic production-seam gateway contracts without provider certification.",
    actions: [
      {
        name: "GATEWAY_HTTP_INGRESS_CONTRACT",
        description:
          "Drive the production webhook HTTP handler through auth, mapping, dedupe, forwarding, and reply egress.",
        validate: async () => true,
        handler: async (_runtime, _message, _state, raw, callback) => {
          const input = options(raw);
          const platform = requiredString(input, "platform");
          const project = requiredString(input, "project");
          const variant = requiredString(input, "variant");
          const agentId = "bound-agent";
          const base = adapterFor(platform);
          let body = base.body;
          const url = `https://gateway.test/webhook/${project}/${platform}/${agentId}`;
          const config = base.config;
          const headers = new Headers(base.request.headers);

          if (platform === "twilio") {
            const params = new URLSearchParams(body);
            if (variant === "wrong-account")
              params.set("AccountSid", "AC_other");
            body = params.toString();
            const signature = crypto
              .createHmac("sha1", String(config.authToken))
              .update(
                `${url}${[...params.keys()]
                  .sort()
                  .map((key) => `${key}${params.get(key)}`)
                  .join("")}`,
              )
              .digest("base64");
            headers.set("x-twilio-signature", signature);
          } else if (platform === "whatsapp") {
            if (variant === "wrong-account") {
              const payload = JSON.parse(body) as {
                entry: Array<{
                  changes: Array<{
                    value: { metadata: { phone_number_id: string } };
                  }>;
                }>;
              };
              const firstChange = payload.entry[0]?.changes[0];
              if (!firstChange) {
                throw new Error("WhatsApp fixture is missing its first change");
              }
              firstChange.value.metadata.phone_number_id = "phone-other";
              body = JSON.stringify(payload);
            }
            headers.set(
              "x-hub-signature-256",
              `sha256=${crypto.createHmac("sha256", String(config.appSecret)).update(body).digest("hex")}`,
            );
          }
          if (variant === "missing-signature") {
            headers.delete("x-telegram-bot-api-secret-token");
            headers.delete("x-twilio-signature");
            headers.delete("x-hub-signature-256");
          } else if (variant === "invalid-signature") {
            if (platform === "telegram")
              headers.set("x-telegram-bot-api-secret-token", "invalid");
            if (platform === "twilio")
              headers.set("x-twilio-signature", "invalid");
            if (platform === "whatsapp")
              headers.set("x-hub-signature-256", `sha256=${"00".repeat(32)}`);
          }

          routeRedis.store.set(`agent:${agentId}:server`, "server-1");
          routeRedis.store.set(
            "server:server-1:url",
            "http://agent-server.test",
          );
          const before = dispatches.length;
          const fetchCalls: Array<{ url: string; body: string }> = [];
          const providerEgressCount = () =>
            fetchCalls.filter(
              (entry) =>
                entry.url.includes("api.telegram.org") ||
                entry.url.includes("api.twilio.com") ||
                entry.url.includes("graph.facebook.com"),
            ).length;
          const originalFetch = globalThis.fetch;
          globalThis.fetch = (async (
            requestInput: string | URL | Request,
            init?: RequestInit,
          ) => {
            const request = new Request(requestInput, init);
            const requestBody =
              request.method === "GET" ? "" : await request.clone().text();
            fetchCalls.push({ url: request.url, body: requestBody });
            if (request.url.includes("/api/internal/webhook/config"))
              return Response.json(config);
            if (request.url.endsWith("/api/internal/identity/resolve"))
              return Response.json({
                userId: "user-owner",
                organizationId: "org-owner",
                agentId,
              });
            if (
              request.url ===
              `http://agent-server.test/agents/${agentId}/message`
            ) {
              dispatches.push({
                platform,
                project,
                body: JSON.parse(requestBody),
                agentId,
              });
              return Response.json({ response: `owned ${platform} reply` });
            }
            if (request.url.includes("api.telegram.org"))
              return Response.json({ ok: true, result: { message_id: 501 } });
            if (request.url.includes("api.twilio.com"))
              return Response.json({ sid: "SM_reply" });
            if (request.url.includes("graph.facebook.com"))
              return Response.json({ messages: [{ id: "wamid-reply" }] });
            throw new Error(`unexpected gateway fetch ${request.url}`);
          }) as typeof fetch;
          let response: Response;
          try {
            response = await handleWebhook(
              new Request(url, { method: "POST", headers, body }),
              base.adapter,
              {
                redis: routeRedis,
                cloudBaseUrl: "https://cloud.test",
                getAuthHeader: () => ({ Authorization: "Bearer gateway" }),
                reacquireAuthHeader: async () => ({
                  Authorization: "Bearer gateway-fresh",
                }),
              },
              project,
              agentId,
            );
            if (
              (variant === "valid" || variant === "cross-tenant") &&
              dispatches.length === before
            ) {
              await waitForCount(() => dispatches.length, before + 1);
            }
            if (variant === "valid" || variant === "cross-tenant") {
              await waitForCount(
                providerEgressCount,
                platform === "twilio" ? 1 : 2,
              );
            }
          } finally {
            globalThis.fetch = originalFetch;
          }
          const responseBody = await response.text();
          const data = {
            status: response.status,
            responseBody,
            effectCount: dispatches.length - before,
            totalEffects: dispatches.length,
            fetchCalls,
            providerEgressCount: providerEgressCount(),
            redisKeys: [...routeRedis.store.keys()].sort(),
          };
          await callback?.({
            text: `gateway HTTP status ${response.status}`,
            action: "GATEWAY_HTTP_INGRESS_CONTRACT",
          });
          return {
            success: response.status < 400,
            text: "gateway HTTP ingress contract",
            data,
          };
        },
      },
      {
        name: "GATEWAY_INGRESS_CONTRACT",
        description:
          "Verify, normalize, own, and deduplicate a signed webhook event.",
        validate: async () => true,
        handler: async (_runtime, _message, _state, raw, callback) => {
          const input = options(raw);
          const platform = requiredString(input, "platform");
          const project = requiredString(input, "project");
          const { adapter, request, body, config } = adapterFor(platform);
          const authorized = await adapter.verifyWebhook(request, body, config);
          const event = await adapter.extractEvent(body);
          if (!authorized || !event)
            throw new Error("signed ingress did not normalize");
          const ownershipKey = `${project}:${platform}:${event.senderId}`;
          const dedupeKey = `${ownershipKey}:${event.messageId}`;
          const duplicate = seen.has(dedupeKey);
          if (!duplicate) {
            seen.add(dedupeKey);
            dispatches.push({ ownershipKey, dedupeKey, event });
          }
          const data = {
            acknowledged: true,
            authorized,
            duplicate,
            ownershipKey,
            dedupeKey,
            event,
            dispatchCount: dispatches.length,
          };
          await callback?.({
            text: duplicate ? "duplicate acknowledged" : "signed event routed",
            action: "GATEWAY_INGRESS_CONTRACT",
          });
          return { success: true, text: "gateway ingress contract", data };
        },
      },
      {
        name: "DISCORD_GATEWAY_ROUTE_CONTRACT",
        description:
          "Exercise bounded Discord routing retry and typed reply validation.",
        validate: async () => true,
        handler: async (_runtime, _message, _state, _raw, callback) => {
          const applicationId = "1474591626759376967";
          const keyPair = crypto.generateKeyPairSync("ed25519");
          const publicKey = keyPair.publicKey
            .export({ format: "der", type: "spki" })
            .subarray(-32)
            .toString("hex");
          const webhookBody = JSON.stringify({
            application_id: applicationId,
            type: 1,
            event: {
              type: "APPLICATION_AUTHORIZED",
              timestamp: "2026-08-14T09:00:00.000000",
              data: {
                integration_type: 1,
                user: { id: "discord-owner-444", global_name: "Taylor" },
              },
            },
          });
          const timestamp = "2026-08-14T09:00:00.000000";
          const signature = crypto
            .sign(
              null,
              Buffer.from(`${timestamp}${webhookBody}`),
              keyPair.privateKey,
            )
            .toString("hex");
          const jobs: unknown[] = [];
          const webhookDeps = {
            applicationId,
            getPublicKey: async () => publicKey,
            enqueue: async (job: unknown) => {
              jobs.push(job);
            },
          };
          const invalidIngress = await handleDiscordEventWebhook(
            new Request("https://gateway.test/discord/event-webhook", {
              method: "POST",
              headers: {
                "content-type": "application/json",
                "x-signature-ed25519": "00".repeat(64),
                "x-signature-timestamp": timestamp,
              },
              body: webhookBody,
            }),
            webhookDeps,
          );
          const validIngress = await handleDiscordEventWebhook(
            new Request("https://gateway.test/discord/event-webhook", {
              method: "POST",
              headers: {
                "content-type": "application/json",
                "x-signature-ed25519": signature,
                "x-signature-timestamp": timestamp,
              },
              body: webhookBody,
            }),
            webhookDeps,
          );
          let attempt = 0;
          const outcome = await postManagedAgentMessageWithRetry({
            doPost: async () => {
              attempt += 1;
              return attempt === 1
                ? new Response("busy", { status: 503 })
                : Response.json({
                    handled: true,
                    agentId: "agent-owner-1",
                    replyText: "owned Discord reply",
                  });
            },
            maxAttempts: 2,
            baseDelayMs: 0,
            sleep: async () => undefined,
          });
          const data = {
            invalidIngressStatus: invalidIngress.status,
            validIngressStatus: validIngress.status,
            durableJobs: jobs.length,
            outcome,
            owner: "agent-owner-1",
            channelId: "discord-dm:444",
          };
          dispatches.push(data);
          await callback?.({
            text: "Discord event routed",
            action: "DISCORD_GATEWAY_ROUTE_CONTRACT",
          });
          return {
            success: outcome.ok,
            text: "Discord gateway contract",
            data,
          };
        },
      },
      {
        name: "BLUEBUBBLES_INGRESS_CONTRACT",
        description:
          "Drive the production BlueBubbles HTTP route through authentication, validation, acknowledgment, and replay-safe service dispatch.",
        validate: async () => true,
        handler: async (_runtime, _message, _state, raw, callback) => {
          const input = options(raw);
          const secret = requiredString(input, "secret");
          const provided = requiredString(input, "provided");
          const messageGuid = requiredString(input, "messageGuid");
          const chatGuid = requiredString(input, "chatGuid");
          const dedupeKey = `bluebubbles:${chatGuid}:${messageGuid}`;
          let duplicate = false;
          const service = {
            handleWebhook: async () => {
              duplicate = seen.has(dedupeKey);
              if (!duplicate) {
                seen.add(dedupeKey);
                dispatches.push({
                  dedupeKey,
                  chatGuid,
                  messageGuid,
                  source: "bluebubbles",
                });
              }
            },
          };
          const route = blueBubblesDataRoutes.find(
            (entry) =>
              entry.type === "POST" && entry.path === "/webhooks/bluebubbles",
          );
          if (!route?.handler)
            throw new Error("BlueBubbles webhook route is not registered");
          let status = 0;
          let responseJson: string | undefined;
          const response = {
            status: (value: number) => {
              status = value;
              return response;
            },
            json: (value: unknown) => {
              responseJson = JSON.stringify(value);
              return response;
            },
          } as unknown as RouteResponse;
          const routeRuntime = {
            getService: (name: string) =>
              name === "bluebubbles" ? service : null,
            getSetting: (name: string) =>
              name === "BLUEBUBBLES_WEBHOOK_SECRET" ? secret : undefined,
          } as unknown as IAgentRuntime;
          await route.handler(
            {
              headers: { "x-bluebubbles-webhook-secret": provided },
              body: {
                type: "new-message",
                data: { guid: messageGuid, chats: [{ guid: chatGuid }] },
              },
            } as RouteRequest,
            response,
            routeRuntime,
          );
          const authorized = verifyBlueBubblesWebhookSecret(secret, provided);
          const data = {
            status,
            responseJson,
            acknowledged: status === 200,
            authorized,
            duplicate,
            dedupeKey,
            chatGuid,
            messageGuid,
            dispatchCount: dispatches.length,
          };
          await callback?.({
            text: "BlueBubbles ingress checked",
            action: "BLUEBUBBLES_INGRESS_CONTRACT",
          });
          return {
            success: status === 200,
            text: "BlueBubbles ingress contract",
            data,
          };
        },
      },
      {
        name: "GATEWAY_CREATE_DRAFT",
        description: "Create an owner-scoped outbound draft without dispatch.",
        validate: async () => true,
        handler: async (_runtime, _message, _state, raw, callback) => {
          const input = options(raw);
          const draftId = requiredString(input, "draftId");
          const draft = {
            draftId,
            channel: requiredString(input, "channel"),
            to: requiredString(input, "to"),
            body: requiredString(input, "body"),
            ownerId: requiredString(input, "ownerId"),
            status: "draft",
          };
          drafts.set(draftId, draft);
          await callback?.({
            text: "Draft created; no provider request made",
            action: "GATEWAY_CREATE_DRAFT",
          });
          return {
            success: true,
            text: "draft created",
            data: { draft, dispatchCount: dispatches.length },
          };
        },
      },
      {
        name: "GATEWAY_CONFIRM_DISPATCH",
        description:
          "Confirm exactly one owner-bound provider request from an existing draft.",
        validate: async () => true,
        handler: async (_runtime, _message, _state, raw, callback) => {
          const input = options(raw);
          const draftId = requiredString(input, "draftId");
          const ownerId = requiredString(input, "ownerId");
          const draft = drafts.get(draftId);
          if (!draft || draft.ownerId !== ownerId)
            throw new Error("draft ownership mismatch");
          if (draft.status === "sent") {
            return {
              success: true,
              text: "dispatch already recorded",
              data: {
                duplicate: true,
                draft,
                dispatchCount: dispatches.length,
              },
            };
          }
          const channel = String(draft.channel);
          let recorded: Awaited<ReturnType<typeof withFetchRecorder<unknown>>>;
          if (channel === "imessage") {
            const client = new BlueBubblesClient({
              serverUrl: "https://bluebubbles.test",
              password: "secret",
            });
            recorded = await withFetchRecorder(
              {
                data: {
                  guid: "bb-guid-1",
                  dateCreated: 1_786_957_200,
                  text: draft.body,
                },
              },
              () =>
                client.sendMessage(String(draft.to), String(draft.body), {
                  tempGuid: draftId,
                }),
            );
          } else if (channel === "sms") {
            recorded = await withFetchRecorder({ sid: "SM_scenario" }, () =>
              sendTwilioSms({
                credentials: TWILIO_CREDENTIALS,
                to: String(draft.to),
                body: String(draft.body),
                idempotencyKey: draftId,
              }),
            );
          } else if (channel === "voice") {
            recorded = await withFetchRecorder({ sid: "CA_scenario" }, () =>
              sendTwilioVoiceCall({
                credentials: TWILIO_CREDENTIALS,
                to: String(draft.to),
                message: String(draft.body),
                idempotencyKey: draftId,
              }),
            );
          } else {
            throw new Error(`unsupported outbound channel: ${channel}`);
          }
          draft.status = "sent";
          const receipt = {
            channel,
            ownerId,
            draftId,
            request: recorded.requests[0],
            result: recorded.result,
          };
          dispatches.push(receipt);
          await callback?.({
            text: `${channel} provider request accepted by fixture boundary`,
            action: "GATEWAY_CONFIRM_DISPATCH",
          });
          return {
            success: true,
            text: "confirmed dispatch",
            data: {
              duplicate: false,
              draft,
              receipt,
              dispatchCount: dispatches.length,
            },
          };
        },
      },
      {
        name: "TWILIO_VOICE_INGRESS_CONTRACT",
        description:
          "Resolve inbound call direction and build the bounded realtime TwiML stream.",
        validate: async () => true,
        handler: async (_runtime, _message, _state, raw, callback) => {
          const input = options(raw);
          const variant =
            typeof input.variant === "string" ? input.variant : "valid";
          const callSid = requiredString(input, "callSid");
          const accountSid =
            variant === "wrong-account" ? "AC_other" : "AC_voice_scenario";
          const requestUrl = "http://local/";
          const form = new URLSearchParams({
            CallSid: callSid,
            AccountSid: accountSid,
            From: requiredString(input, "from"),
            To: requiredString(input, "to"),
            CallStatus: "ringing",
            Direction:
              typeof input.direction === "string" ? input.direction : "inbound",
          });
          const signature = crypto
            .createHmac("sha1", "voice-auth-token")
            .update(
              `${requestUrl}${[...form.keys()]
                .sort()
                .map((key) => `${key}${form.get(key)}`)
                .join("")}`,
            )
            .digest("base64");
          const routeModulePath =
            "../../../../cloud/api/v1/twilio/voice/inbound/route.ts";
          const routeModule = (await import(routeModulePath)) as {
            default: {
              request(
                url: string,
                init: RequestInit,
                env: Record<string, string>,
              ): Promise<Response>;
            };
          };
          const twilioVoiceInboundRoute = routeModule.default;
          const ingressResponse = await twilioVoiceInboundRoute.request(
            requestUrl,
            {
              method: "POST",
              headers: {
                "content-type": "application/x-www-form-urlencoded",
                "x-twilio-signature":
                  variant === "invalid-signature" ? "invalid" : signature,
              },
              body: form.toString(),
            },
            {
              TWILIO_AUTH_TOKEN: "voice-auth-token",
              TWILIO_ACCOUNT_SID: "AC_voice_scenario",
            } as never,
          );
          const ingressBody = await ingressResponse.text();
          const participants = resolveTwilioCallParticipants({
            direction:
              typeof input.direction === "string" ? input.direction : undefined,
            from: requiredString(input, "from"),
            to: requiredString(input, "to"),
          });
          const twiml = buildRealtimeVoiceTwiML({
            streamUrl: "wss://api.test/api/v1/twilio/voice/media",
            sessionId: "voice-session-91",
            token: "scoped-media-token",
          });
          const data = {
            status: ingressResponse.status,
            ingressBody,
            participants,
            twiml,
            persistedCall: {
              callSid,
              callerNumber: participants.callerNumber,
              direction: participants.outbound ? "outbound" : "inbound",
            },
          };
          if (ingressResponse.status === 200) dispatches.push(data);
          await callback?.({
            text: "Twilio voice ingress mapped",
            action: "TWILIO_VOICE_INGRESS_CONTRACT",
          });
          return {
            success: ingressResponse.status === 200,
            text: "voice ingress contract",
            data,
          };
        },
      },
      {
        name: "TWILIO_BILLING_CONTRACT",
        description:
          "Calculate the production gateway Twilio segment and markup ledger.",
        validate: async () => true,
        handler: async (_runtime, _message, _state, raw, callback) => {
          const input = options(raw);
          const body = requiredString(input, "body");
          const billing = calculateTwilioSmsBilling(
            body,
            requiredNumber(input, "costPerSegment"),
          );
          await callback?.({
            text: "Twilio SMS billing calculated",
            action: "TWILIO_BILLING_CONTRACT",
          });
          return { success: true, text: "billing contract", data: { billing } };
        },
      },
    ],
  };
  singleton = {
    plugin,
    dispatches,
    reset: () => {
      dispatches.length = 0;
      seen.clear();
      drafts.clear();
      routeRedis.store.clear();
    },
  };
  return singleton;
}
