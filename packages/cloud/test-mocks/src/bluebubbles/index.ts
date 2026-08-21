/**
 * Hosts a stateful BlueBubbles REST and webhook simulator for the production
 * connector. Its authenticated control plane owns deterministic reset, seed,
 * fault, state, and ledger inspection; production clients see only protocol
 * routes and never receive the control credential.
 */

import { createHash, randomBytes } from "node:crypto";
import type { SyntheticWorld } from "@elizaos/synthetic-world";
import { startFetchServer } from "../fetch-server.js";
import {
  createProviderMockControl,
  PROVIDER_MOCK_CONTROL_PREFIX,
  ProviderMockControlClient,
  providerMockCoordinatorFor,
} from "../provider-contract/control.js";
import type {
  ProviderProtocolFault,
  ProviderProtocolFixture,
} from "../provider-contract/types.js";

export interface BlueBubblesMockChat {
  guid: string;
  chatIdentifier: string;
  displayName: string | null;
  participants: Array<{ address: string; service: string }>;
}

export interface BlueBubblesMockMessage {
  guid: string;
  text: string | null;
  dateCreated: number;
  chatGuid: string;
  tempGuid?: string;
  isFromMe: boolean;
  dateRead?: number | null;
  dateEdited?: number | null;
}

export interface BlueBubblesMockAccountSeed {
  accountId: string;
  password: string;
  chats: readonly BlueBubblesMockChat[];
  messages?: readonly BlueBubblesMockMessage[];
}

export interface BlueBubblesWebhookEvent {
  id: string;
  sequence: number;
  accountId: string;
  type: "new-message" | "updated-message" | "chat-updated";
  data: Record<string, unknown>;
}

export interface BlueBubblesMockLedgerEntry {
  sequence: number;
  kind: "request" | "effect" | "webhook";
  operation: string;
  accountId: string | null;
  outcome: "succeeded" | "rejected" | "ambiguous" | "replayed";
  idempotencyKey: string | null;
  occurredAt: string;
  detail: Record<string, unknown>;
}

export interface StartBlueBubblesMockOptions {
  accounts: readonly BlueBubblesMockAccountSeed[];
  world?: SyntheticWorld;
  now?: () => number;
}

export interface RunningBlueBubblesMock {
  url: string;
  control: ProviderMockControlClient;
  readonly ledger: readonly BlueBubblesMockLedgerEntry[];
  deliverWebhook(
    targetUrl: string,
    event: BlueBubblesWebhookEvent,
    secret: string,
    options?: { maxAttempts?: number; retryDelayMs?: number },
  ): Promise<Response[]>;
  stop(): Promise<void>;
}

interface AccountState {
  accountId: string;
  password: string;
  chats: Map<string, BlueBubblesMockChat>;
  messages: Map<string, BlueBubblesMockMessage>;
  tempGuids: Map<string, string>;
}

export async function startBlueBubblesMock(
  options: StartBlueBubblesMockOptions,
): Promise<RunningBlueBubblesMock> {
  if (options.accounts.length === 0) {
    throw new Error("BlueBubbles mock requires at least one account");
  }
  if (options.world && options.now) {
    throw new Error("BlueBubbles mock accepts either world or now(), not both");
  }
  const initialAccounts = structuredClone(options.accounts);
  const accounts = new Map<string, AccountState>();
  const passwordOwners = new Map<string, string>();
  const faults = new Map<string, ProviderProtocolFault[]>();
  const fixtures = new Map<string, ProviderProtocolFixture>();
  const ledger: BlueBubblesMockLedgerEntry[] = [];
  const deliveredWebhookIds = new Set<string>();
  const latestWebhookSequences = new Map<string, number>();
  const now = options.world
    ? () => options.world?.clock.now().getTime() ?? 0
    : (options.now ?? Date.now);
  let sequence = 0;

  const restoreInitialState = (): void => {
    accounts.clear();
    passwordOwners.clear();
    for (const seed of initialAccounts) {
      if (accounts.has(seed.accountId) || passwordOwners.has(seed.password)) {
        throw new Error(
          "BlueBubbles mock account IDs and passwords must be unique",
        );
      }
      accounts.set(seed.accountId, {
        accountId: seed.accountId,
        password: seed.password,
        chats: new Map(
          seed.chats.map((chat) => [chat.guid, structuredClone(chat)]),
        ),
        messages: new Map(
          (seed.messages ?? []).map((message) => [
            message.guid,
            structuredClone(message),
          ]),
        ),
        tempGuids: new Map(
          (seed.messages ?? [])
            .filter((message) => message.tempGuid)
            .map((message) => [message.tempGuid as string, message.guid]),
        ),
      });
      passwordOwners.set(seed.password, seed.accountId);
    }
    faults.clear();
    fixtures.clear();
    ledger.length = 0;
    deliveredWebhookIds.clear();
    latestWebhookSequences.clear();
    sequence = 0;
  };
  restoreInitialState();

  const append = (
    entry: Omit<BlueBubblesMockLedgerEntry, "sequence" | "occurredAt">,
  ): void => {
    ledger.push({
      ...structuredClone(entry),
      sequence: ++sequence,
      occurredAt: new Date(now()).toISOString(),
    });
  };

  const enqueueFault = (
    method: string,
    path: string,
    fault: ProviderProtocolFault,
  ): void => {
    const key = `${method.toUpperCase()} ${path}`;
    faults.set(key, [...(faults.get(key) ?? []), structuredClone(fault)]);
  };

  const controlToken = `control_${randomBytes(32).toString("base64url")}`;
  const controlHandler = createProviderMockControl({
    providerId: "bluebubbles",
    token: controlToken,
    now,
    coordinator: options.world
      ? providerMockCoordinatorFor(options.world)
      : undefined,
    adapter: {
      reset: restoreInitialState,
      seed(nextFixtures) {
        for (const fixture of nextFixtures) {
          fixtures.set(
            `${fixture.method} ${fixture.path}`,
            structuredClone(fixture),
          );
        }
      },
      enqueueFault,
      inspect: () => inspectState(accounts, faults, fixtures, ledger),
      executionState: () => ({
        ...inspectState(accounts, faults, fixtures, ledger),
        passwords: [...passwordOwners.keys()].map(secretDigest).sort(),
      }),
    },
  });

  const server = await startFetchServer(async (request) => {
    const controlled = await controlHandler.handle(request);
    if (controlled) return controlled;
    const url = new URL(request.url);
    const key = `${request.method} ${url.pathname}`;
    const body = request.method === "GET" ? null : await request.text();
    const accountId = passwordOwners.get(
      url.searchParams.get("password") ?? "",
    );
    const account = accountId ? accounts.get(accountId) : undefined;
    append({
      kind: "request",
      operation: key,
      accountId: accountId ?? null,
      outcome: account ? "succeeded" : "rejected",
      idempotencyKey: null,
      detail: {
        path: url.pathname,
        query: Object.fromEntries(
          [...url.searchParams.entries()].map(([name, value]) => [
            name,
            name.toLowerCase().includes("password") ? "<redacted>" : value,
          ]),
        ),
        body: body === null ? null : redactSecrets(body, passwordOwners.keys()),
      },
    });
    if (!account)
      return protocolError(401, "Unauthorized", "Authentication Error");

    const queued = faults.get(key) ?? [];
    const fault = queued.shift();
    if (queued.length === 0) faults.delete(key);
    else faults.set(key, queued);

    await waitForDelay(fault, options.world);

    if (request.method === "POST" && url.pathname === "/api/v1/message/text") {
      const parsed = parseObject(body);
      if (!parsed)
        return protocolError(400, "Invalid JSON", "Validation Error");
      const chatGuid = stringField(parsed, "chatGuid");
      const text = stringField(parsed, "message");
      const tempGuid = optionalStringField(parsed, "tempGuid");
      if (!chatGuid || !text || !account.chats.has(chatGuid)) {
        return protocolError(422, "Invalid message", "Validation Error");
      }
      const existingGuid = tempGuid
        ? account.tempGuids.get(tempGuid)
        : undefined;
      if (existingGuid) {
        const existing = account.messages.get(existingGuid);
        append({
          kind: "effect",
          operation: "message.send",
          accountId: account.accountId,
          outcome: "replayed",
          idempotencyKey: tempGuid ?? null,
          detail: { messageGuid: existingGuid },
        });
        return protocolSuccess(
          "Message already sent!",
          toProtocolMessage(existing, account),
        );
      }
      const guid = `msg-${account.accountId}-${account.messages.size + 1}`;
      const message: BlueBubblesMockMessage = {
        guid,
        text,
        dateCreated: now(),
        chatGuid,
        tempGuid,
        isFromMe: true,
      };
      const commitBeforeResponse =
        fault?.type === "status" && fault.status >= 500;
      if (!fault || fault.type === "delay" || commitBeforeResponse) {
        account.messages.set(guid, message);
        if (tempGuid) account.tempGuids.set(tempGuid, guid);
        append({
          kind: "effect",
          operation: "message.send",
          accountId: account.accountId,
          outcome: commitBeforeResponse ? "ambiguous" : "succeeded",
          idempotencyKey: tempGuid ?? null,
          detail: { messageGuid: guid },
        });
      }
      const faultResponse = terminalFaultResponse(fault);
      if (faultResponse) return faultResponse;
      return protocolSuccess(
        "Message sent!",
        toProtocolMessage(message, account),
      );
    }

    if (
      request.method === "POST" &&
      url.pathname === "/api/v1/message/attachment"
    ) {
      const chatGuid = multipartField(body, "chatGuid");
      const tempGuid = multipartField(body, "tempGuid") ?? undefined;
      if (!chatGuid || !account.chats.has(chatGuid)) {
        return protocolError(422, "Invalid attachment", "Validation Error");
      }
      const existingGuid = tempGuid
        ? account.tempGuids.get(tempGuid)
        : undefined;
      if (existingGuid) {
        append({
          kind: "effect",
          operation: "attachment.send",
          accountId: account.accountId,
          outcome: "replayed",
          idempotencyKey: tempGuid ?? null,
          detail: { messageGuid: existingGuid },
        });
        return protocolSuccess(
          "Attachment already sent!",
          toProtocolMessage(account.messages.get(existingGuid), account),
        );
      }
      const guid = `attachment-${account.accountId}-${account.messages.size + 1}`;
      const message: BlueBubblesMockMessage = {
        guid,
        text: multipartField(body, "message"),
        dateCreated: now(),
        chatGuid,
        tempGuid,
        isFromMe: true,
      };
      const commitBeforeResponse =
        fault?.type === "status" && fault.status >= 500;
      if (!fault || fault.type === "delay" || commitBeforeResponse) {
        account.messages.set(guid, message);
        if (tempGuid) account.tempGuids.set(tempGuid, guid);
        append({
          kind: "effect",
          operation: "attachment.send",
          accountId: account.accountId,
          outcome: commitBeforeResponse ? "ambiguous" : "succeeded",
          idempotencyKey: tempGuid ?? null,
          detail: { messageGuid: guid },
        });
      }
      const faultResponse = terminalFaultResponse(fault);
      if (faultResponse) return faultResponse;
      return protocolSuccess(
        "Attachment sent!",
        toProtocolMessage(message, account),
      );
    }

    const faultResponse = terminalFaultResponse(fault);
    if (faultResponse) return faultResponse;
    const fixture = fixtures.get(key);
    if (fixture) return fixtureResponse(fixture);
    if (request.method === "GET" && url.pathname === "/api/v1/server/info") {
      return protocolSuccess("Server info fetched!", {
        os_version: "14.6-synthetic",
        server_version: "1.9.9",
        private_api: true,
        helper_connected: true,
        proxy_service: null,
        detected_icloud: null,
      });
    }
    if (request.method === "POST" && url.pathname === "/api/v1/chat/query") {
      const parsed = parseObject(body) ?? {};
      const limit = numberField(parsed, "limit") ?? 100;
      const offset = numberField(parsed, "offset") ?? 0;
      return protocolSuccess(
        "Chats fetched!",
        [...account.chats.values()].slice(offset, offset + limit),
      );
    }
    const messageMatch = url.pathname.match(
      /^\/api\/v1\/chat\/([^/]+)\/message$/,
    );
    if (request.method === "GET" && messageMatch?.[1]) {
      const chatGuid = decodeURIComponent(messageMatch[1]);
      const limit = Number(url.searchParams.get("limit") ?? 50);
      const offset = Number(url.searchParams.get("offset") ?? 0);
      return protocolSuccess(
        "Messages fetched!",
        [...account.messages.values()]
          .filter((message) => message.chatGuid === chatGuid)
          .slice(offset, offset + limit)
          .map((message) => toProtocolMessage(message, account)),
      );
    }
    const chatMatch = url.pathname.match(/^\/api\/v1\/chat\/([^/]+)$/);
    if (request.method === "GET" && chatMatch?.[1]) {
      const chat = account.chats.get(decodeURIComponent(chatMatch[1]));
      return chat
        ? protocolSuccess("Chat fetched!", chat)
        : protocolError(404, "Chat does not exist!", "Database Error");
    }
    const readMatch = url.pathname.match(/^\/api\/v1\/chat\/([^/]+)\/read$/);
    if (request.method === "POST" && readMatch?.[1]) {
      const chatGuid = decodeURIComponent(readMatch[1]);
      const changed = [...account.messages.values()].filter(
        (message) => message.chatGuid === chatGuid && !message.isFromMe,
      );
      for (const message of changed) message.dateRead = now();
      append({
        kind: "effect",
        operation: "chat.mark-read",
        accountId: account.accountId,
        outcome: "succeeded",
        idempotencyKey: chatGuid,
        detail: {
          chatGuid,
          changedMessageGuids: changed.map(({ guid }) => guid),
        },
      });
      return protocolSuccess("Chat marked as read!", { success: true });
    }
    if (request.method === "POST" && url.pathname === "/api/v1/message/react") {
      const parsed = parseObject(body);
      const messageGuid = parsed ? stringField(parsed, "messageGuid") : null;
      const reaction = parsed ? stringField(parsed, "reaction") : null;
      if (!messageGuid || !reaction || !account.messages.has(messageGuid)) {
        return protocolError(422, "Invalid reaction", "Validation Error");
      }
      append({
        kind: "effect",
        operation: "message.react",
        accountId: account.accountId,
        outcome: "succeeded",
        idempotencyKey: `${messageGuid}:${reaction}`,
        detail: { messageGuid, reaction },
      });
      return protocolSuccess("Reaction sent!", { success: true });
    }
    const mutationMatch = url.pathname.match(
      /^\/api\/v1\/message\/([^/]+)\/(edit|unsend)$/,
    );
    if (request.method === "POST" && mutationMatch?.[1] && mutationMatch[2]) {
      const messageGuid = decodeURIComponent(mutationMatch[1]);
      const message = account.messages.get(messageGuid);
      if (!message) {
        return protocolError(404, "Message does not exist!", "Database Error");
      }
      if (mutationMatch[2] === "edit") {
        const parsed = parseObject(body);
        const editedMessage = parsed
          ? stringField(parsed, "editedMessage")
          : null;
        if (!editedMessage) {
          return protocolError(
            422,
            "Invalid edited message",
            "Validation Error",
          );
        }
        message.text = editedMessage;
        message.dateEdited = now();
      } else {
        account.messages.delete(messageGuid);
        if (message.tempGuid) account.tempGuids.delete(message.tempGuid);
      }
      append({
        kind: "effect",
        operation: `message.${mutationMatch[2]}`,
        accountId: account.accountId,
        outcome: "succeeded",
        idempotencyKey: messageGuid,
        detail: { messageGuid, readback: toProtocolMessage(message, account) },
      });
      return protocolSuccess(
        mutationMatch[2] === "edit" ? "Message edited!" : "Message unsent!",
        { success: true },
      );
    }
    return protocolError(
      404,
      "The requested resource was not found",
      "Not Found",
    );
  });

  const url = `http://${server.hostname}:${server.port}`;
  return {
    url,
    control: new ProviderMockControlClient(
      `${url}${PROVIDER_MOCK_CONTROL_PREFIX}`,
      controlToken,
    ),
    get ledger() {
      return structuredClone(ledger);
    },
    async deliverWebhook(targetUrl, event, secret, deliveryOptions = {}) {
      const responses: Response[] = [];
      const maxAttempts = deliveryOptions.maxAttempts ?? 3;
      const retryDelayMs = deliveryOptions.retryDelayMs ?? 1_000;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        const deliveryKey = `${event.accountId}:${event.id}`;
        const duplicate = deliveredWebhookIds.has(deliveryKey);
        const latestSequence = latestWebhookSequences.get(event.accountId) ?? 0;
        const response = await fetch(targetUrl, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-bluebubbles-webhook-secret": secret,
          },
          body: JSON.stringify({ type: event.type, data: event.data }),
        });
        responses.push(response);
        append({
          kind: "webhook",
          operation: event.type,
          accountId: event.accountId,
          outcome: duplicate
            ? "replayed"
            : response.ok
              ? "succeeded"
              : "rejected",
          idempotencyKey: event.id,
          detail: {
            attempt,
            status: response.status,
            sequence: event.sequence,
            outOfOrder: event.sequence <= latestSequence,
          },
        });
        if (response.ok) {
          deliveredWebhookIds.add(deliveryKey);
          latestWebhookSequences.set(
            event.accountId,
            Math.max(latestSequence, event.sequence),
          );
          break;
        }
        if (attempt < maxAttempts) {
          if (options.world) await options.world.clock.sleep(retryDelayMs);
          else
            await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
        }
      }
      return responses;
    },
    async stop() {
      controlHandler.dispose();
      await server.stop();
    },
  };
}

function inspectState(
  accounts: ReadonlyMap<string, AccountState>,
  faults: ReadonlyMap<string, readonly ProviderProtocolFault[]>,
  fixtures: ReadonlyMap<string, ProviderProtocolFixture>,
  ledger: readonly BlueBubblesMockLedgerEntry[],
): Record<string, unknown> {
  return {
    accounts: [...accounts.values()]
      .map((account) => ({
        accountId: account.accountId,
        chats: [...account.chats.keys()].sort(),
        messages: [...account.messages.values()].map((message) => ({
          ...message,
        })),
      }))
      .sort((left, right) => left.accountId.localeCompare(right.accountId)),
    pendingFaults: [...faults.entries()]
      .map(([target, queue]) => ({ target, faults: structuredClone(queue) }))
      .sort((left, right) => left.target.localeCompare(right.target)),
    fixtureIds: [...fixtures.values()].map((fixture) => fixture.id).sort(),
    ledger: structuredClone(ledger),
  };
}

function toProtocolMessage(
  message: BlueBubblesMockMessage | undefined,
  account: AccountState,
): Record<string, unknown> | null {
  if (!message) return null;
  const chat = account.chats.get(message.chatGuid);
  return {
    guid: message.guid,
    text: message.text,
    subject: null,
    country: null,
    handle: chat?.participants[0]
      ? {
          ...chat.participants[0],
          country: null,
          originalROWID: 1,
          uncanonicalizedId: null,
        }
      : null,
    handleId: 1,
    otherHandle: 0,
    chats: chat ? [{ ...chat, lastMessage: null }] : [],
    attachments: [],
    expressiveSendStyleId: null,
    dateCreated: message.dateCreated,
    dateRead: message.dateRead ?? null,
    dateDelivered: null,
    isFromMe: message.isFromMe,
    isDelayed: false,
    isAutoReply: false,
    isSystemMessage: false,
    isServiceMessage: false,
    isForward: false,
    isArchived: false,
    hasDdResults: false,
    hasPayloadData: false,
    threadOriginatorGuid: null,
    threadOriginatorPart: null,
    associatedMessageGuid: null,
    associatedMessageType: null,
    balloonBundleId: null,
    dateEdited: message.dateEdited ?? null,
    error: 0,
    itemType: 0,
    groupTitle: null,
    groupActionType: 0,
    payloadData: null,
  };
}

async function waitForDelay(
  fault: ProviderProtocolFault | undefined,
  world?: SyntheticWorld,
): Promise<void> {
  if (fault?.type === "delay") {
    if (world) await world.clock.sleep(fault.durationMs);
    else await new Promise((resolve) => setTimeout(resolve, fault.durationMs));
  }
}

function terminalFaultResponse(
  fault: ProviderProtocolFault | undefined,
): Response | null {
  if (!fault || fault.type === "delay") return null;
  if (fault.type === "malformed-json") {
    return new Response(fault.body ?? "{not-json", {
      headers: { "content-type": "application/json" },
    });
  }
  if (fault.type === "schema-drift") return json(fault.body);
  if (fault.body === undefined) {
    return protocolError(
      fault.status,
      fault.status >= 500 ? "Message Send Error" : "Request rejected",
      fault.status >= 500 ? "iMessage Error" : "Request Error",
      protocolHeaders(fault.headers),
    );
  }
  return json(fault.body, fault.status, protocolHeaders(fault.headers));
}

function fixtureResponse(fixture: ProviderProtocolFixture): Response {
  return fixture.response.rawBody === undefined
    ? json(
        fixture.response.body,
        fixture.response.status,
        protocolHeaders(fixture.response.headers),
      )
    : new Response(fixture.response.rawBody, {
        status: fixture.response.status,
        headers: protocolHeaders(fixture.response.headers),
      });
}

function protocolHeaders(
  headers: Record<string, string> | undefined,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers ?? {}).filter(
      ([name]) => !name.toLowerCase().startsWith("x-eliza-mock-"),
    ),
  );
}

function protocolSuccess(message: string, data: unknown): Response {
  return json({ status: 200, message, data });
}

function protocolError(
  status: number,
  message: string,
  type: string,
  headers: Record<string, string> = {},
): Response {
  return json(
    {
      status,
      message,
      error: { type, message },
      data: null,
    },
    status,
    headers,
  );
}

function parseObject(body: string | null): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(body ?? "");
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function stringField(
  value: Record<string, unknown>,
  field: string,
): string | null {
  const candidate = value[field];
  return typeof candidate === "string" && candidate.trim() ? candidate : null;
}

function optionalStringField(
  value: Record<string, unknown>,
  field: string,
): string | undefined {
  return stringField(value, field) ?? undefined;
}

function numberField(
  value: Record<string, unknown>,
  field: string,
): number | null {
  const candidate = value[field];
  return typeof candidate === "number" && Number.isFinite(candidate)
    ? candidate
    : null;
}

function multipartField(body: string | null, field: string): string | null {
  if (!body) return null;
  const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = body.match(
    new RegExp(
      `name="${escaped}"(?:;[^\\r\\n]*)?\\r?\\n(?:[^\\r\\n]*\\r?\\n)?\\r?\\n([^\\r\\n]+)`,
    ),
  );
  return match?.[1]?.trim() || null;
}

function secretDigest(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

function redactSecrets(value: string, secrets: Iterable<string>): string {
  let redacted = value;
  for (const secret of secrets) {
    const values = [
      secret,
      encodeURIComponent(secret),
      encodeURIComponent(encodeURIComponent(secret)),
    ]
      .filter(Boolean)
      .sort((left, right) => right.length - left.length);
    for (const candidate of values) {
      redacted = redacted.split(candidate).join("<redacted>");
    }
  }
  return redacted;
}

function json(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}
