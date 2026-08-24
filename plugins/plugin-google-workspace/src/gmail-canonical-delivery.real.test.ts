/**
 * Exercises MESSAGE through a real AgentRuntime, migrated PGlite identity
 * authority, production Gmail connector/client, and a stateful loopback Google
 * API. Only the external provider is simulated; runtime and persistence code
 * are the same implementations used in production.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  type Action,
  type ActionResult,
  getConnectorAccountManager,
  type Memory,
  ServiceType,
  stringToUuid,
  type UUID,
} from "@elizaos/core";
import { createTestRuntime } from "@elizaos/core/testing";
import { identityClaimTable } from "@elizaos/plugin-sql";
import { Auth } from "googleapis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import googlePlugin from "./index.js";
import { GoogleWorkspaceService } from "./service.js";
import type { GoogleAuthClient, GoogleCredentialResolver } from "./types.js";

const PRINCIPAL_ID = "00000000-0000-0000-0000-0000000000e7" as UUID;
const SENDER_ID = "00000000-0000-0000-0000-0000000000e8" as UUID;
const ACCOUNT_ID = "00000000-0000-4000-8000-0000000000a1" as UUID;
const ROOM_ID = "00000000-0000-0000-0000-0000000000b1" as UUID;
const WORLD_ID = "00000000-0000-0000-0000-0000000000c1" as UUID;

interface RecordedGmailRequest {
  authorization: string | undefined;
  raw: string;
}

class LoopbackCredentialResolver implements GoogleCredentialResolver {
  async getAuthClient(): Promise<GoogleAuthClient> {
    const auth = new Auth.OAuth2Client();
    auth.setCredentials({
      access_token: "canonical-delivery-loopback-token",
      expiry_date: Date.now() + 60 * 60 * 1000,
    });
    return auth;
  }
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Gmail fixture request must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function writeJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

describe("canonical principal to Gmail delivery", () => {
  let server: Server;
  let originalGoogleBase: string | undefined;
  let cleanup: (() => Promise<void>) | undefined;
  let runtime: Awaited<ReturnType<typeof createTestRuntime>>["runtime"];
  let messageAction: Action;
  const providerRequests: RecordedGmailRequest[] = [];

  beforeAll(async () => {
    originalGoogleBase = process.env.ELIZA_MOCK_GOOGLE_BASE;
    server = createServer((request, response) => {
      void (async () => {
        const url = new URL(request.url ?? "/", "http://fixture.invalid");
        if (request.method !== "POST" || url.pathname !== "/gmail/v1/users/me/messages/send") {
          writeJson(response, 404, { error: { code: 404 } });
          return;
        }
        const body = await readJson(request);
        const raw = typeof body.raw === "string" ? body.raw : "";
        providerRequests.push({
          authorization: request.headers.authorization,
          raw: Buffer.from(raw, "base64url").toString("utf8"),
        });
        writeJson(response, 200, {
          id: `fixture-message-${providerRequests.length}`,
          threadId: "fixture-thread-1",
          labelIds: ["SENT"],
        });
      })().catch((error) => {
        writeJson(response, 500, {
          error: { code: 500, message: error instanceof Error ? error.message : String(error) },
        });
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    process.env.ELIZA_MOCK_GOOGLE_BASE = `http://127.0.0.1:${address.port}/`;

    const harness = await createTestRuntime({
      characterName: "CanonicalDeliveryAgent",
      plugins: [googlePlugin],
    });
    runtime = harness.runtime;
    cleanup = harness.cleanup;
    const google = runtime.getService<GoogleWorkspaceService>(GoogleWorkspaceService.serviceType);
    if (!google) throw new Error("GoogleWorkspaceService did not start");
    google.setCredentialResolver(new LoopbackCredentialResolver());

    messageAction = runtime.actions.find((action) => action.name === "MESSAGE") as Action;
    if (!messageAction) throw new Error("MESSAGE action is not registered");

    await runtime.upsertEntities([
      { id: PRINCIPAL_ID, agentId: runtime.agentId, names: ["Shadow"], metadata: {} },
      { id: SENDER_ID, agentId: runtime.agentId, names: ["Owner"], metadata: {} },
    ]);
    await runtime.ensureWorldExists({
      id: WORLD_ID,
      agentId: runtime.agentId,
      name: "Fixture world",
      metadata: { type: "fixture" },
    });
    await runtime.ensureRoomExists({
      id: ROOM_ID,
      worldId: WORLD_ID,
      source: "client_chat",
      name: "Fixture room",
      channelId: "fixture-room",
      type: "DM",
    });
    await runtime.ensureParticipantInRoom(SENDER_ID, ROOM_ID);
    await runtime.upsertComponent({
      id: stringToUuid("canonical-delivery-malicious-legacy-email") as UUID,
      entityId: PRINCIPAL_ID,
      agentId: runtime.agentId,
      roomId: ROOM_ID,
      worldId: WORLD_ID,
      sourceEntityId: runtime.agentId,
      type: "contact_info",
      createdAt: Date.now(),
      data: { email: "attacker@example.com" },
    });

    await getConnectorAccountManager(runtime).upsertAccount("google", {
      id: ACCOUNT_ID,
      provider: "google",
      role: "AGENT",
      purpose: ["messaging"],
      accessGate: "open",
      status: "connected",
      externalId: "fixture-owner",
      displayHandle: "owner@example.com",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      metadata: { grantedCapabilities: ["gmail.send"] },
    });
  }, 180_000);

  afterAll(async () => {
    await cleanup?.();
    if (originalGoogleBase === undefined) delete process.env.ELIZA_MOCK_GOOGLE_BASE;
    else process.env.ELIZA_MOCK_GOOGLE_BASE = originalGoogleBase;
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  async function sendToPrincipal(): Promise<ActionResult> {
    const result = await messageAction.handler(
      runtime,
      {
        id: stringToUuid(`canonical-delivery-input-${providerRequests.length}`) as UUID,
        agentId: runtime.agentId,
        entityId: SENDER_ID,
        roomId: ROOM_ID,
        worldId: WORLD_ID,
        content: { text: "Send Shadow the fixture note", source: "client_chat" },
        createdAt: Date.now(),
      } as Memory,
      undefined,
      {
        parameters: {
          action: "send",
          source: "gmail",
          target: PRINCIPAL_ID,
          targetKind: "contact",
          message: "Canonical delivery fixture body",
          subject: "Canonical delivery fixture",
          persist: false,
        },
      },
      undefined,
      undefined
    );
    if (!result) throw new Error("MESSAGE returned no result");
    return result;
  }

  it("refuses the legacy component, then sends through the exact verified account claim", async () => {
    const withoutClaim = await sendToPrincipal();
    expect(withoutClaim.success).toBe(false);
    expect(withoutClaim.data).toMatchObject({ error: "TARGET_DELIVERY_CLAIM_MISSING" });
    expect(providerRequests).toHaveLength(0);

    await runtime.adapter.db.insert(identityClaimTable).values({
      agentId: runtime.agentId,
      principalEntityId: PRINCIPAL_ID,
      namespace: "connector_subject",
      connectorId: "google",
      connectorAccountId: ACCOUNT_ID,
      externalSubjectId: "shadow@example.com",
      handle: "shadow@example.com",
      displayName: "Shadow",
      verification: "verified",
      status: "active",
      confidence: 1,
      provenance: { fixture: "loopback-google" },
      evidence: { verified: true },
      verifiedAt: new Date(),
    });

    const delivered = await sendToPrincipal();
    if (!delivered.success) {
      throw new Error(`Expected canonical delivery success: ${JSON.stringify(delivered)}`);
    }
    expect(delivered.success).toBe(true);
    expect(delivered.data).toMatchObject({
      deliveryStatus: "delivered",
      responseMessageId: "fixture-message-1",
      identityDeliveryClaim: {
        canonicalPrincipalId: PRINCIPAL_ID,
        connectorAccountId: ACCOUNT_ID,
      },
    });
    expect(providerRequests).toHaveLength(1);
    expect(providerRequests[0]?.authorization).toBe("Bearer canonical-delivery-loopback-token");
    expect(providerRequests[0]?.raw).toContain("To: shadow@example.com");
    expect(providerRequests[0]?.raw).not.toContain("attacker@example.com");
    expect(providerRequests[0]?.raw).toContain("Canonical delivery fixture body");
    expect(runtime.getService(ServiceType.PRINCIPAL)).not.toBeNull();
  });
});
