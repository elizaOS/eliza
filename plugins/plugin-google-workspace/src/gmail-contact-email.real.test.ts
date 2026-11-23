/**
 * CONTACT create and update store a contact's email on entity metadata
 * (`metadata.email`), and the Gmail send connector advertises "a contact with
 * a stored email" as a target. This suite saves contacts through the real
 * CONTACT action and sends through the real MESSAGE action on a real
 * AgentRuntime (PGlite), the production Gmail connector and client, and a
 * loopback Google API. Only the external provider is simulated.
 */
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  type Action,
  type ActionResult,
  getConnectorAccountManager,
  type Memory,
  stringToUuid,
  type UUID,
} from "@elizaos/core";
import {
  createAssistantPlugin,
  createContactActions,
  relationshipsPlugin,
} from "@elizaos/plugin-assistant";
import { createTestRuntime } from "@elizaos/testing/runtime";
import { Auth } from "googleapis";
import { afterAll, beforeAll, expect, it } from "vitest";
import googlePlugin from "./index.js";
import { GoogleWorkspaceService } from "./service.js";
import type { GoogleAuthClient, GoogleCredentialResolver } from "./types.js";

const SENDER_ID = "00000000-0000-0000-0000-0000000000f8" as UUID;
const ACCOUNT_ID = "00000000-0000-4000-8000-0000000000f1" as UUID;
const ROOM_ID = "00000000-0000-0000-0000-0000000000f2" as UUID;
const WORLD_ID = "00000000-0000-0000-0000-0000000000f3" as UUID;

// Addresses of a case, as numbered in GmailContactEmail.qnt.
const NONE = 0;
const ADDRESSES: Record<number, string> = {
  1: "jill@acme.example",
  2: "jill.park@home.example",
  3: "front-desk@acme.example",
};
// Refusals of a case, as numbered in GmailContactEmail.qnt.
const NO_REFUSAL = 0;
const UNRESOLVED = 1;
const AMBIGUOUS = 2;
const CLAIM_MISSING = 3;

interface ModelCase {
  /** IDENTITY_DELIVERY_CLAIMS_AUTHORITATIVE is on. */
  claims: boolean;
  /** The email CONTACT create stores (NONE: created without one). */
  contact: number;
  /** An `email` field on another component of the entity. */
  named: number;
  /** An email-shaped value under another key of that component. */
  shaped: number;
  /** The address the send went to (NONE: nothing sent). */
  delivered: number;
  refusal: number;
}

// Without the generated cases, the contacts develop could not email and
// their controls.
const DEFAULT_CASES: ModelCase[] = [
  { claims: false, contact: 1, named: NONE, shaped: NONE, delivered: 1, refusal: NO_REFUSAL },
  { claims: false, contact: 1, named: NONE, shaped: 3, delivered: 1, refusal: NO_REFUSAL },
  { claims: false, contact: 1, named: 1, shaped: NONE, delivered: 1, refusal: NO_REFUSAL },
  { claims: false, contact: 1, named: 2, shaped: NONE, delivered: NONE, refusal: AMBIGUOUS },
  { claims: false, contact: NONE, named: NONE, shaped: NONE, delivered: NONE, refusal: UNRESOLVED },
  { claims: true, contact: 1, named: NONE, shaped: NONE, delivered: NONE, refusal: CLAIM_MISSING },
];

const casesFile = process.env.ELIZA_GMAIL_CONTACT_EMAIL_MODEL_CASES;
const cases: ModelCase[] = casesFile ? JSON.parse(readFileSync(casesFile, "utf8")) : DEFAULT_CASES;

class LoopbackCredentialResolver implements GoogleCredentialResolver {
  async getAuthClient(): Promise<GoogleAuthClient> {
    const auth = new Auth.OAuth2Client();
    auth.setCredentials({
      access_token: "contact-email-loopback-token",
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
    throw new Error("Gmail loopback request must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function writeJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

let server: Server;
let originalGoogleBase: string | undefined;
let cleanup: (() => Promise<void>) | undefined;
let runtime: Awaited<ReturnType<typeof createTestRuntime>>["runtime"];
let messageAction: Action;
// The production CONTACT action, composed the way packages/agent composes it.
const { contactAction } = createContactActions({
  resolveGraph: async () => null,
  hasContextSignal: () => true,
});
const sentMessages: string[] = [];
let turn = 0;

beforeAll(async () => {
  originalGoogleBase = process.env.ELIZA_MOCK_GOOGLE_BASE;
  server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://loopback.invalid");
      if (request.method !== "POST" || url.pathname !== "/gmail/v1/users/me/messages/send") {
        writeJson(response, 404, { error: { code: 404 } });
        return;
      }
      const body = await readJson(request);
      const raw = typeof body.raw === "string" ? body.raw : "";
      sentMessages.push(Buffer.from(raw, "base64url").toString("utf8"));
      writeJson(response, 200, {
        id: `contact-email-message-${sentMessages.length}`,
        threadId: "contact-email-thread",
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
    characterName: "ContactEmailAgent",
    plugins: [createAssistantPlugin(), relationshipsPlugin, googlePlugin],
  });
  runtime = harness.runtime;
  cleanup = harness.cleanup;
  const google = runtime.getService<GoogleWorkspaceService>(GoogleWorkspaceService.serviceType);
  if (!google) throw new Error("GoogleWorkspaceService did not start");
  google.setCredentialResolver(new LoopbackCredentialResolver());
  // CONTACT create writes through the relationships service.
  await runtime.getServiceLoadPromise("relationships");
  messageAction = runtime.actions.find((action) => action.name === "MESSAGE") as Action;
  if (!messageAction) throw new Error("MESSAGE action is not registered");

  await runtime.upsertEntities([
    { id: SENDER_ID, agentId: runtime.agentId, names: ["Owner"], metadata: {} },
  ]);
  await runtime.ensureWorldExists({
    id: WORLD_ID,
    agentId: runtime.agentId,
    name: "Contact email world",
    metadata: { type: "loopback" },
  });
  await runtime.ensureRoomExists({
    id: ROOM_ID,
    worldId: WORLD_ID,
    source: "client_chat",
    name: "Contact email room",
    channelId: "contact-email-room",
    type: "DM",
  });
  await runtime.ensureParticipantInRoom(SENDER_ID, ROOM_ID);
  await getConnectorAccountManager(runtime).upsertAccount("google", {
    id: ACCOUNT_ID,
    provider: "google",
    role: "AGENT",
    purpose: ["messaging"],
    accessGate: "open",
    status: "connected",
    externalId: "loopback-owner",
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

function ownerMessage(text: string): Memory {
  turn += 1;
  return {
    id: stringToUuid(`contact-email-turn-${turn}`) as UUID,
    agentId: runtime.agentId,
    entityId: SENDER_ID,
    roomId: ROOM_ID,
    worldId: WORLD_ID,
    content: { text, source: "client_chat" },
    createdAt: Date.now(),
  } as Memory;
}

async function runContact(parameters: Record<string, string>): Promise<ActionResult> {
  const result = await contactAction.handler(
    runtime,
    ownerMessage(`Contact ${String(parameters.action)}`),
    undefined,
    { parameters },
    undefined,
    undefined
  );
  if (!result?.success) throw new Error(`CONTACT failed: ${JSON.stringify(result)}`);
  return result;
}

async function createContact(name: string, email?: string): Promise<UUID> {
  const result = await runContact({ action: "create", name, ...(email ? { email } : {}) });
  const entityId = (result.data as { entityId?: unknown } | undefined)?.entityId;
  if (typeof entityId !== "string") {
    throw new Error(`CONTACT create returned no entityId: ${JSON.stringify(result)}`);
  }
  return entityId as UUID;
}

/** MESSAGE op=send source=gmail to the contact; the address sent to, or the refusal. */
async function emailContact(entityId: UUID): Promise<{ to: string | null; error: unknown }> {
  const before = sentMessages.length;
  const result = await messageAction.handler(
    runtime,
    ownerMessage("Email the contact the note"),
    undefined,
    {
      parameters: {
        action: "send",
        source: "gmail",
        target: entityId,
        targetKind: "contact",
        message: "Contact email body",
        subject: "Contact email",
        persist: false,
      },
    },
    undefined,
    undefined
  );
  if (!result) throw new Error("MESSAGE returned no result");
  const sent = sentMessages.slice(before);
  expect(sent.length).toBeLessThanOrEqual(1);
  const to = sent[0]?.match(/^To: (.+)$/m)?.[1]?.trim() ?? null;
  expect(result.success).toBe(to !== null);
  // A refusal carries the connector's code in the MESSAGE result.
  return {
    to,
    error: result.success ? null : JSON.stringify({ text: result.text, data: result.data }),
  };
}

it("emails a contact at the email CONTACT stored", async () => {
  runtime.setSetting("IDENTITY_DELIVERY_CLAIMS_AUTHORITATIVE", "false");
  const jill = await createContact("Jill Park", "jill@acme.example");
  expect((await runtime.getEntityById(jill))?.metadata?.email).toBe("jill@acme.example");
  expect(await emailContact(jill)).toEqual({ to: "jill@acme.example", error: null });

  await runContact({ action: "update", entityId: jill, email: "jill.park@home.example" });
  expect(await emailContact(jill)).toEqual({ to: "jill.park@home.example", error: null });
}, 120_000);

const REFUSALS: Record<number, string> = {
  [UNRESOLVED]: "GMAIL_RECIPIENT_UNRESOLVED",
  [AMBIGUOUS]: "GMAIL_RECIPIENT_AMBIGUOUS",
  [CLAIM_MISSING]: "TARGET_DELIVERY_CLAIM_MISSING",
};

/** Saves the case's contact, sends to it, and returns the observed outcome. */
async function replayCase(index: number, item: ModelCase) {
  runtime.setSetting("IDENTITY_DELIVERY_CLAIMS_AUTHORITATIVE", item.claims ? "true" : "false");
  const entityId = await createContact(
    `Model contact ${index} ${JSON.stringify(item)}`,
    item.contact === NONE ? undefined : ADDRESSES[item.contact]
  );
  const data: Record<string, string> = {};
  if (item.named !== NONE) data.email = ADDRESSES[item.named] as string;
  if (item.shaped !== NONE) data.frontDesk = ADDRESSES[item.shaped] as string;
  if (Object.keys(data).length > 0) {
    await runtime.createComponent({
      id: stringToUuid(`contact-email-profile-${entityId}`) as UUID,
      entityId,
      agentId: runtime.agentId,
      roomId: ROOM_ID,
      worldId: WORLD_ID,
      sourceEntityId: runtime.agentId,
      type: "profile",
      createdAt: Date.now(),
      data,
    });
  }
  const { to, error } = await emailContact(entityId);
  const delivered =
    to === null
      ? NONE
      : Number(Object.entries(ADDRESSES).find(([, address]) => address === to)?.[0] ?? -1);
  const refusal =
    error === null
      ? NO_REFUSAL
      : Number(
          Object.entries(REFUSALS).find(([, code]) => String(error).includes(code))?.[0] ?? -1
        );
  return { delivered, refusal, error };
}

const NAMES: Record<number, string> = { 0: "none", 1: "A", 2: "B" };

it.each(
  [false, true].flatMap((claims) =>
    [NONE, 1, 2].map((contact) => ({
      name: `${claims ? "claim" : "legacy"} mode, contact ${NAMES[contact]}`,
      group: cases.filter((item) => item.claims === claims && item.contact === contact),
    }))
  )
)(
  "gmail model replays $name",
  async ({ group }) => {
    // Without generated cases only the cases listed above run.
    if (!casesFile && group.length === 0) return;
    expect(group.length).toBeGreaterThan(0);
    for (const [index, item] of group.entries()) {
      const observed = await replayCase(index, item);
      expect({ case: item, delivered: observed.delivered, refusal: observed.refusal }).toEqual({
        case: item,
        delivered: item.delivered,
        refusal: item.refusal,
      });
    }
  },
  600_000
);
