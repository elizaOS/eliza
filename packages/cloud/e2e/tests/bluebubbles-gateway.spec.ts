/**
 * Exercises the registered BlueBubbles gateway across the real local Cloud
 * stack, relay subprocess, generated HTTP router, database, shared Eliza
 * runtime, and deterministic model; only the Apple/BlueBubbles server is
 * substituted because this lane must remain keyless and device-independent.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ELIZA_APP_TEST_JWT_SECRET } from "../src/fixtures/env";
import { seedTestUser } from "../src/fixtures/seed";
import { seedModelPricing } from "../src/helpers/seed-pricing";
import { expect, test } from "../src/helpers/test-fixtures";

test.use({ stackOptions: { frontend: false, mockLlm: true } });

const MODEL = "openai/gpt-4o-mini";
const REPO_ROOT = resolve(import.meta.dirname, "../../../..");

type JsonRecord = Record<string, unknown>;

interface RegistrationData {
  id: string;
  bridgeId: string;
  phoneNumber: string;
  routingMode: "sender-owned" | "fixed-agent";
  agentId: string | null;
  webhookUrl: string;
  token: string;
}

interface FakeBlueBubblesServer {
  server: Server;
  url: string;
  sends: JsonRecord[];
  webhookCreates: JsonRecord[];
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<JsonRecord> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? (JSON.parse(raw) as JsonRecord) : {};
}

async function startFakeBlueBubbles(): Promise<FakeBlueBubblesServer> {
  const sends: JsonRecord[] = [];
  const webhookCreates: JsonRecord[] = [];
  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (req.method === "GET" && url.pathname === "/api/v1/server/info") {
        json(res, 200, {
          status: 200,
          data: { server_version: "e2e", private_api: false },
        });
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/v1/webhook") {
        json(res, 200, { status: 200, data: [] });
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/v1/webhook") {
        const body = await readJson(req);
        webhookCreates.push(body);
        json(res, 200, { status: 200, data: { id: 1, ...body } });
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/v1/message/text") {
        const body = await readJson(req);
        sends.push(body);
        json(res, 200, { status: 200, data: { guid: "outbound-e2e" } });
        return;
      }
      json(res, 404, { error: "not found" });
    })().catch((error) => {
      // error-policy:J1 the fake HTTP boundary exposes malformed test traffic.
      json(res, 500, {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  });
  await new Promise<void>((accept, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", accept);
  });
  const address = server.address() as AddressInfo;
  return {
    server,
    url: `http://127.0.0.1:${address.port}`,
    sends,
    webhookCreates,
  };
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((accept, reject) =>
    server.close((error) => (error ? reject(error) : accept())),
  );
}

async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((accept, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", accept);
  });
  const address = server.address() as AddressInfo;
  await closeServer(server);
  return address.port;
}

function bunExecutable(): string {
  if (process.env.BUN && existsSync(process.env.BUN)) return process.env.BUN;
  const homeBun = resolve(homedir(), ".bun/bin/bun");
  return existsSync(homeBun) ? homeBun : "bun";
}

async function waitForRelay(baseUrl: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/not-found`);
      if (response.status === 404) return;
    } catch {
      // error-policy:J5 the next bounded poll observes the same startup state.
    }
    await delay(50);
  }
  throw new Error("BlueBubbles relay did not start within 15 seconds");
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((accept) => child.once("exit", () => accept())),
    delay(5_000),
  ]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
  }
}

function authHeaders(apiKey: string): Record<string, string> {
  return {
    authorization: `Bearer ${apiKey}`,
    "x-api-key": apiKey,
  };
}

test.describe("registered BlueBubbles gateway", () => {
  test("onboards an unknown sender, links their Cloud account, routes the next text to their agent, and revokes the credential", async ({
    stack,
    seededUser,
  }) => {
    expect(stack.urls.mockLlm, "mock LLM is available").toBeTruthy();
    await seedModelPricing({
      model: MODEL,
      billingSource: "bitrouter",
      provider: "openai",
    });

    const senderUser = await seedTestUser({
      slug: `bluebubbles-sender-${Date.now().toString(36)}`,
    });
    const senderPhone = `+1415${Date.now().toString().slice(-7)}`;

    const registrationResponse = await fetch(
      `${stack.urls.api}/api/v1/phone-gateways/bluebubbles`,
      {
        method: "POST",
        headers: {
          ...authHeaders(seededUser.apiKey),
          "content-type": "application/json",
        },
        body: JSON.stringify({
          phoneNumber: "+1 (415) 555-0123",
          friendlyName: "E2E iPhone",
        }),
      },
    );
    expect(
      registrationResponse.status,
      `registration returned ${registrationResponse.status}: ${await registrationResponse.clone().text()}`,
    ).toBe(201);
    const registrationBody = (await registrationResponse.json()) as {
      data?: RegistrationData;
    };
    const registration = registrationBody.data;
    expect(registration?.routingMode).toBe("sender-owned");
    expect(registration?.agentId).toBeNull();
    expect(registration?.phoneNumber).toBe("+14155550123");
    expect(registration?.bridgeId).toMatch(/^bb-[0-9a-f-]{36}$/);
    expect(registration?.token).toMatch(/^bbg_[0-9a-f]{64}$/);
    expect(registration?.webhookUrl).toBe(
      `${stack.urls.api}/api/webhooks/bluebubbles/${registration?.bridgeId}`,
    );
    if (!registration) throw new Error("Gateway registration returned no data");

    const fakeBlueBubbles = await startFakeBlueBubbles();
    const relayPort = await unusedPort();
    const relayBaseUrl = `http://127.0.0.1:${relayPort}`;
    const relay = spawn(
      bunExecutable(),
      [
        "run",
        resolve(
          REPO_ROOT,
          "packages/cloud/scripts/bluebubbles-local-bridge.ts",
        ),
      ],
      {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          BLUEBUBBLES_BRIDGE_PORT: String(relayPort),
          BLUEBUBBLES_SERVER_URL: fakeBlueBubbles.url,
          BLUEBUBBLES_PASSWORD: "e2e-password",
          BLUEBUBBLES_GATEWAY_TOKEN: registration.token,
          BLUEBUBBLES_BRIDGE_ID: registration.bridgeId,
          BLUEBUBBLES_GATEWAY_PHONE_NUMBER: registration.phoneNumber,
          ELIZA_CLOUD_BLUEBUBBLES_URL: registration.webhookUrl,
          BLUEBUBBLES_AUTO_START: "false",
          BLUEBUBBLES_SEND_METHOD: "apple-script",
        },
        stdio: "ignore",
      },
    );

    try {
      await waitForRelay(relayBaseUrl);
      const onboardingInboundResponse = await fetch(
        `${relayBaseUrl}/webhooks/bluebubbles`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            type: "new-message",
            data: {
              guid: `inbound-${crypto.randomUUID()}`,
              text: "My name is Casey",
              isFromMe: false,
              handle: { address: senderPhone, service: "iMessage" },
              chats: [
                {
                  guid: `iMessage;-;${senderPhone}`,
                  chatIdentifier: senderPhone,
                  // The relay fail-closes unless the event proves which local
                  // account received it. Real BlueBubbles payloads carry this
                  // field; keep the fixture on the routed onboarding path.
                  lastAddressedHandle: registration.phoneNumber,
                },
              ],
            },
          }),
        },
      );
      expect(
        onboardingInboundResponse.status,
        `relay returned ${onboardingInboundResponse.status}: ${await onboardingInboundResponse.clone().text()}`,
      ).toBe(200);
      const onboardingInboundBody =
        (await onboardingInboundResponse.json()) as JsonRecord;
      expect(onboardingInboundBody).toMatchObject({
        success: true,
        handled: true,
        reason: "unknown_owner",
        replied: true,
        replyQueued: false,
      });
      expect(stack.mocks.mockLlm?.requestCount()).toBe(0);
      expect(fakeBlueBubbles.sends).toHaveLength(1);
      const onboardingReply = String(fakeBlueBubbles.sends[0]?.message ?? "");
      // Copy is intentionally conversational and may evolve; the durable
      // contract is an inline, parseable continuation URL carrying the session.
      expect(onboardingReply.toLowerCase()).toContain("connect your account");
      const onboardingUrl = onboardingReply.match(/https:\/\/\S+/)?.[0];
      expect(onboardingUrl, "onboarding continuation URL").toBeTruthy();
      if (!onboardingUrl)
        throw new Error("Onboarding reply did not contain a URL");
      const continuationToken = new URL(onboardingUrl).searchParams.get(
        "onboardingSession",
      );
      expect(continuationToken).toMatch(/^[0-9a-f-]{36}$/);
      if (!continuationToken)
        throw new Error("Onboarding URL did not contain a session token");

      const savedJwtSecret = process.env.ELIZA_APP_JWT_SECRET;
      process.env.ELIZA_APP_JWT_SECRET = ELIZA_APP_TEST_JWT_SECRET;
      const { elizaAppSessionService } = await import(
        "@elizaos/cloud-shared/lib/services/eliza-app/session-service"
      );
      const signedInSession = await elizaAppSessionService
        .createSession(senderUser.userId, senderUser.organizationId)
        .finally(() => {
          if (savedJwtSecret === undefined) {
            delete process.env.ELIZA_APP_JWT_SECRET;
          } else {
            process.env.ELIZA_APP_JWT_SECRET = savedJwtSecret;
          }
        });
      const continuationResponse = await fetch(
        `${stack.urls.api}/api/eliza-app/onboarding/chat`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${signedInSession.token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            sessionId: continuationToken,
            platform: "blooio",
          }),
        },
      );
      expect(
        continuationResponse.status,
        `continuation returned ${continuationResponse.status}: ${await continuationResponse.clone().text()}`,
      ).toBe(200);
      const continuationBody = (await continuationResponse.json()) as {
        data?: {
          requiresLogin?: boolean;
          provisioning?: { agentId?: string | null };
        };
      };
      expect(continuationBody.data?.requiresLogin).toBe(false);
      const agentId = continuationBody.data?.provisioning?.agentId;
      expect(agentId, "onboarding provisioned agent id").toBeTruthy();
      if (!agentId)
        throw new Error("Onboarding returned no provisioned agent id");

      const { usersRepository } = await import(
        "@elizaos/cloud-shared/db/repositories/users"
      );
      await expect(
        usersRepository.findByPhoneNumberWithOrganization(senderPhone),
      ).resolves.toMatchObject({
        id: senderUser.userId,
        organization_id: senderUser.organizationId,
      });

      const linkedInboundResponse = await fetch(
        `${relayBaseUrl}/webhooks/bluebubbles`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            type: "new-message",
            data: {
              guid: `linked-${crypto.randomUUID()}`,
              text: "Reply through my linked phone gateway.",
              isFromMe: false,
              handle: { address: senderPhone, service: "iMessage" },
              chats: [
                {
                  guid: `iMessage;-;${senderPhone}`,
                  chatIdentifier: senderPhone,
                  lastAddressedHandle: registration.phoneNumber,
                },
              ],
            },
          }),
        },
      );
      expect(linkedInboundResponse.status).toBe(200);
      const linkedInboundBody =
        (await linkedInboundResponse.json()) as JsonRecord;
      expect(linkedInboundBody).toMatchObject({
        success: true,
        handled: true,
        agentId,
        organizationId: senderUser.organizationId,
        userId: senderUser.userId,
        replied: true,
        replyQueued: false,
      });
      expect(fakeBlueBubbles.sends[1]).toMatchObject({
        chatGuid: `iMessage;-;${senderPhone}`,
        // The onboarding-created shared agent intentionally has no model
        // override in this credential-free lane. Prove the linked turn reached
        // that agent and its deterministic fail-closed reply was relayed.
        message:
          "Eliza is temporarily unavailable (no shared model configured).",
        method: "apple-script",
      });

      const inboundEventsResponse = await fetch(
        `${relayBaseUrl}/inbound-events?sender=${encodeURIComponent(senderPhone)}&marker=linked%20phone`,
      );
      expect(inboundEventsResponse.status).toBe(200);
      const inboundEvents = (await inboundEventsResponse.json()) as {
        count?: number;
        events?: JsonRecord[];
      };
      expect(inboundEvents.count).toBe(1);
      expect(inboundEvents.events?.[0]).toMatchObject({
        sender: senderPhone,
        handled: true,
        agentId,
        organizationId: senderUser.organizationId,
        userId: senderUser.userId,
        replied: true,
        replyQueued: false,
      });

      await expect.poll(() => fakeBlueBubbles.webhookCreates.length).toBe(1);
      expect(fakeBlueBubbles.webhookCreates[0]).toEqual({
        url: `${relayBaseUrl}/webhooks/bluebubbles`,
        events: ["new-message"],
      });

      const listResponse = await fetch(
        `${stack.urls.api}/api/v1/phone-gateways/bluebubbles`,
        { headers: authHeaders(seededUser.apiKey) },
      );
      expect(listResponse.status).toBe(200);
      const listBody = (await listResponse.json()) as {
        data?: {
          gateways?: Array<{
            id: string;
            routingMode: "sender-owned" | "fixed-agent";
            agentId: string | null;
            userId: string;
            status: string;
          }>;
        };
      };
      expect(listBody.data?.gateways).toContainEqual(
        expect.objectContaining({
          id: registration.id,
          routingMode: "sender-owned",
          agentId: null,
          userId: seededUser.userId,
          status: "connected",
        }),
      );

      const revokeResponse = await fetch(
        `${stack.urls.api}/api/v1/phone-gateways/bluebubbles/${registration.id}`,
        {
          method: "DELETE",
          headers: authHeaders(seededUser.apiKey),
        },
      );
      expect(revokeResponse.status).toBe(200);

      const rejectedResponse = await fetch(registration.webhookUrl, {
        method: "POST",
        headers: {
          authorization: `Bearer ${registration.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          type: "new-message",
          data: {
            guid: `revoked-${crypto.randomUUID()}`,
            text: "This must not reach the agent.",
            isFromMe: false,
            handle: { address: "+14155550999", service: "iMessage" },
          },
        }),
      });
      expect(rejectedResponse.status).toBe(401);
      expect(stack.mocks.mockLlm?.requestCount()).toBe(0);
    } finally {
      // error-policy:J6 test teardown must release the relay and loopback server.
      await stopChild(relay);
      await closeServer(fakeBlueBubbles.server);
    }
  });
});
