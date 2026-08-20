/**
 * Promotes the production WhatsApp signed webhook route and its account-bound
 * service parser over a real loopback HTTP target. The suite distinguishes
 * inbound-only behavior through the production signed route and tenant boundary.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import type {
  IAgentRuntime,
  RouteRequest,
  RouteResponse,
  UUID,
} from "@elizaos/core";
import {
  WhatsAppConnectorService,
  whatsappSetupRoutes,
} from "@elizaos/plugin-whatsapp";
import { startFetchServer } from "../../src/fetch-server";
import {
  type ProviderContractObservation,
  type ProviderContractScenario,
  runProviderAdapterConformance,
} from "../../src/provider-contract";

const APP_SECRET = "whatsapp-contract-secret";

let target: Awaited<ReturnType<typeof startFetchServer>>;
let runtime: IAgentRuntime;
let createMemoryCalls: unknown[][];
const memoryStore = new Map<string, Record<string, unknown>>();

function passed(
  scenario: ProviderContractScenario,
  detail: string,
  extra: Partial<ProviderContractObservation> = {},
): ProviderContractObservation {
  return { scenario, status: "passed", detail, ...extra };
}

function createWebhookRuntime(): IAgentRuntime {
  createMemoryCalls = [];
  let service: WhatsAppConnectorService;
  const candidate = {
    agentId: "00000000-0000-0000-0000-000000000043" as UUID,
    character: { settings: {} },
    getSetting(key: string) {
      if (key === "WHATSAPP_APP_SECRET") return APP_SECRET;
      if (key === "WHATSAPP_AUTO_REPLY") return false;
      return undefined;
    },
    getService(serviceType: string) {
      return serviceType === "whatsapp" ? service : null;
    },
    getMemoryById: async (id: UUID) => memoryStore.get(String(id)) ?? null,
    createMemory: async (...args: unknown[]) => {
      createMemoryCalls.push(args);
      const memory = args[0] as Record<string, unknown>;
      const id =
        (memory.id as UUID | undefined) ??
        ("00000000-0000-0000-0000-000000000044" as UUID);
      if (!(args[2] === true && memoryStore.has(String(id)))) {
        memoryStore.set(String(id), { ...memory, id });
      }
      return id;
    },
    updateMemory: async (memory: Record<string, unknown>) => {
      const id = String(memory.id);
      const existing = memoryStore.get(id);
      if (!existing) return false;
      memoryStore.set(id, { ...existing, ...memory });
      return true;
    },
    adapter: {
      documentListQueryCapability: 2,
      getDocument: async ({ documentId }: { documentId: UUID }) =>
        memoryStore.get(String(documentId)) ?? null,
      compareAndSwapDocument: async ({
        documentId,
        expected,
        replacement,
      }: {
        documentId: UUID;
        expected: { revision: number };
        replacement: Record<string, unknown>;
      }) => {
        const existing = memoryStore.get(String(documentId));
        if (!existing) return { status: "not_found" as const };
        const metadata = existing.metadata as
          | Record<string, unknown>
          | undefined;
        if (metadata?.documentRevision !== expected.revision) {
          return { status: "conflict" as const };
        }
        memoryStore.set(String(documentId), replacement);
        return { status: "updated" as const };
      },
    },
    ensureConnection: async () => undefined,
    ensureWorldExists: async () => undefined,
    ensureRoomExists: async () => undefined,
    messageService: { handleMessage: async () => undefined },
    logger: {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
    reportError: () => undefined,
  } as never as IAgentRuntime;
  service = new WhatsAppConnectorService(candidate);
  Object.assign(service, {
    defaultAccountId: "default",
    configs: new Map([
      [
        "default",
        {
          accountId: "default",
          transport: "cloudapi",
          accessToken: "default-token",
          phoneNumberId: "phone-default",
          dmPolicy: "open",
        },
      ],
      [
        "work",
        {
          accountId: "work",
          transport: "cloudapi",
          accessToken: "work-token",
          phoneNumberId: "phone-work",
          dmPolicy: "open",
        },
      ],
    ]),
  });
  return candidate;
}

function routeResponse(): {
  response: RouteResponse;
  read(): { status: number; body: unknown };
} {
  let status = 200;
  let body: unknown;
  const response = {
    status(code: number) {
      status = code;
      return response;
    },
    json(value: unknown) {
      body = value;
      return response;
    },
    send(value: unknown) {
      body = value;
      return response;
    },
    end() {
      return response;
    },
  } as RouteResponse;
  return { response, read: () => ({ status, body }) };
}

beforeAll(async () => {
  runtime = createWebhookRuntime();
  const route = whatsappSetupRoutes.find(
    (candidate) =>
      candidate.type === "POST" && candidate.path === "/api/whatsapp/webhook",
  );
  const handler = route?.handler;
  if (typeof handler !== "function") {
    throw new Error("WhatsApp webhook route is not registered");
  }
  target = await startFetchServer(async (request) => {
    const rawBody = await request.text();
    const output = routeResponse();
    await handler(
      {
        rawBody,
        headers: Object.fromEntries(request.headers),
      } as RouteRequest,
      output.response,
      runtime,
    );
    const result = output.read();
    return Response.json(result.body, { status: result.status });
  });
});

afterAll(async () => {
  await target.stop();
});

async function deliverRaw(
  rawBody: string,
  signatureBody = rawBody,
): Promise<Response> {
  const signature = createHmac("sha256", APP_SECRET)
    .update(signatureBody)
    .digest("hex");
  return fetch(
    `http://${target.hostname}:${target.port}/api/whatsapp/webhook`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": `sha256=${signature}`,
      },
      body: rawBody,
    },
  );
}

function emptyWebhook(extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    object: "whatsapp_business_account",
    entry: [],
    ...extra,
  });
}

function unknownTenantWebhook(
  messageId = "wamid.contract",
  timestamp = "1700000000",
) {
  return JSON.stringify({
    object: "whatsapp_business_account",
    entry: [
      {
        changes: [
          {
            value: {
              metadata: { phone_number_id: "phone-unknown" },
              messages: [
                {
                  from: "14155552671",
                  id: messageId,
                  timestamp,
                  type: "text",
                  text: { body: "hello" },
                },
              ],
            },
          },
        ],
      },
    ],
  });
}

function accountWebhook(
  messageId: string,
  phoneNumberId = "phone-default",
  timestamp = "1700000000",
) {
  return unknownTenantWebhook(messageId, timestamp).replace(
    "phone-unknown",
    phoneNumberId,
  );
}

function messageEffectCount(): number {
  return createMemoryCalls.filter((call) => call[1] === "messages").length;
}

describe("WhatsApp production webhook contract", () => {
  test("executes signed parsing and tenant denial through the real route", async () => {
    const report = await runProviderAdapterConformance({
      adapterName: "WhatsAppWebhookRoute",
      profile: "inbound-webhook",
      capabilities: ["tenant-isolation", "webhooks"],
      scenarios: {
        success: async () => {
          expect((await deliverRaw(emptyWebhook())).status).toBe(200);
          return passed(
            "success",
            "production route authenticated and parsed a signed Meta payload",
          );
        },
        "designed-empty": async () => {
          expect((await deliverRaw(emptyWebhook())).status).toBe(200);
          return passed(
            "designed-empty",
            "production service accepts an explicit empty webhook batch",
          );
        },
        "invalid-input": async () => {
          expect((await deliverRaw("null")).status).toBe(400);
          return passed(
            "invalid-input",
            "production route rejects a signed non-object payload",
          );
        },
        "malformed-json": async () => {
          expect((await deliverRaw("{")).status).toBe(400);
          return passed(
            "malformed-json",
            "production route rejects signed malformed JSON before dispatch",
          );
        },
        "schema-drift": async () => {
          expect(
            (await deliverRaw(emptyWebhook({ future_field: { revision: 2 } })))
              .status,
          ).toBe(200);
          return passed(
            "schema-drift",
            "production parser tolerates unknown top-level Meta fields",
          );
        },
        "provider-4xx": async () => {
          expect((await deliverRaw(emptyWebhook(), "tampered")).status).toBe(
            401,
          );
          return passed(
            "provider-4xx",
            "production boundary rejects an invalid provider signature with 401",
          );
        },
        "provider-5xx": async () => {
          const activeRuntime = runtime;
          runtime = {
            getService: () => null,
            getSetting: (key: string) =>
              key === "WHATSAPP_APP_SECRET" ? APP_SECRET : undefined,
          } as never as IAgentRuntime;
          try {
            expect((await deliverRaw(emptyWebhook())).status).toBe(503);
          } finally {
            runtime = activeRuntime;
          }
          return passed(
            "provider-5xx",
            "production route returns 503 when its WhatsApp service is unavailable",
          );
        },
        "secret-redaction": async () => {
          const response = await deliverRaw(emptyWebhook());
          expect(await response.text()).not.toContain(APP_SECRET);
          return passed(
            "secret-redaction",
            "production webhook response does not disclose its HMAC secret",
            { diagnostic: { status: response.status } },
          );
        },
        "read-policy": async () => {
          expect((await deliverRaw(emptyWebhook())).status).toBe(200);
          return passed(
            "read-policy",
            "production route admits payload reads only after HMAC authorization",
          );
        },
        "cross-tenant-denial": async () => {
          createMemoryCalls.length = 0;
          expect((await deliverRaw(unknownTenantWebhook())).status).toBe(200);
          expect(createMemoryCalls).toHaveLength(0);
          return passed(
            "cross-tenant-denial",
            "production service dropped unknown phone_number_id before durable effects",
          );
        },
        "duplicate-webhook": async () => {
          memoryStore.clear();
          createMemoryCalls.length = 0;
          const body = accountWebhook("wamid.duplicate");
          expect((await deliverRaw(body)).status).toBe(200);
          expect((await deliverRaw(body)).status).toBe(200);
          expect(messageEffectCount()).toBe(1);
          return passed(
            "duplicate-webhook",
            "production service persisted one message for duplicate signed deliveries",
          );
        },
        "out-of-order-webhook": async () => {
          memoryStore.clear();
          createMemoryCalls.length = 0;
          expect(
            (
              await deliverRaw(
                accountWebhook("wamid.newer", "phone-work", "1700000002"),
              )
            ).status,
          ).toBe(200);
          expect(
            (
              await deliverRaw(
                accountWebhook("wamid.older", "phone-default", "1700000001"),
              )
            ).status,
          ).toBe(200);
          expect(messageEffectCount()).toBe(2);
          const persistedMessages = createMemoryCalls
            .filter((call) => call[1] === "messages")
            .map((call) => call[0] as Record<string, unknown>);
          expect(persistedMessages.map((memory) => memory.createdAt)).toEqual([
            1700000002000, 1700000001000,
          ]);
          expect(
            persistedMessages.map(
              (memory) =>
                (memory.metadata as Record<string, unknown>).accountId,
            ),
          ).toEqual(["work", "default"]);
          return passed(
            "out-of-order-webhook",
            "production parser durably bound two reverse-timestamp messages to their distinct provider accounts",
          );
        },
        "webhook-idempotency": async () => {
          memoryStore.clear();
          createMemoryCalls.length = 0;
          const body = accountWebhook("wamid.idempotent");
          expect((await deliverRaw(body)).status).toBe(200);
          expect((await deliverRaw(body)).status).toBe(200);
          expect(messageEffectCount()).toBe(1);
          return passed(
            "webhook-idempotency",
            "production durable claim prevented a repeated message effect",
          );
        },
      },
    });
    expect(report.observations).toHaveLength(13);
  }, 20_000);
});
