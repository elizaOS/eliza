/**
 * Real-poller Telegram membership lifecycle e2e (#28715 review evidence).
 *
 * Boots the REAL `TelegramService` long-poll loop against a local
 * wire-compatible Telegram Bot API HTTP server (keyless — no BotFather token,
 * no network) and drives the complete membership-authority lifecycle through
 * the production path: Telegraf `getUpdates` long-poll → service middlewares →
 * `MessageManager.handleMessage` admission gate → real `SqlMembershipService`
 * over PGLite. Denial legs are classified on three independent dimensions
 * (per-room memory writes, deterministic-provider model invocations, and the
 * authority's own `authorize` decision), not on a single aggregate count.
 *
 * The `it.fails` tripwire at the bottom pins the KNOWN connector-path
 * recovery deadlock; the first (green) test doubles as its companion proof
 * that the shared harness itself admits messages, so a red tripwire is
 * attributable to the deadlock rather than a broken boot. Deterministic;
 * runs entirely on 127.0.0.1.
 */
import type { UUID } from "@elizaos/core";
import { createUniqueUuid, ModelType } from "@elizaos/core";
import {
  benignExternalMessageFixture,
  createTestRuntimeWithModelProvider,
  type DeterministicModelFixture,
  type ModelProviderTestRuntime,
} from "@elizaos/core/testing";
import {
  DEFAULT_ACCOUNT_ID,
  resolveTelegramRuntimeEntityId,
  TelegramService,
} from "@elizaos/plugin-telegram";
import type { Chat, ChatMember, ChatMemberUpdated, User } from "telegraf/types";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

/** Local wire-server identity constants (never reach api.telegram.org). */
const BOT_TOKEN = "111111:LOCAL_WIRE_EVIDENCE_TOKEN";
const BOT_ID = 111_111;
const CHAT_ID = -480_15;
/**
 * Deterministic update timestamps: strictly increasing with update_id, so
 * the authority's out-of-order guard (Telegram dates are one-second
 * resolution; EQUAL is not newer) can never silently skip an event for
 * landing in the same wall-clock second as its predecessor.
 */
const BASE_DATE = Math.floor(Date.now() / 1000) - 10_000;
const dateFor = (updateId: number): number => BASE_DATE + updateId;
/** Membership chat-room key for the default account (`membershipChatRoomKey`). */
const CHAT_KEY = String(CHAT_ID);
const MEMBER_TG_ID = 480_151;
const MEMBER2_TG_ID = 480_152;
const HOST = "127.0.0.1";

/**
 * Bot-API `status` values the harness transitions the BOT through. The wire
 * shapes below are the exact discriminated union members telegraf/types
 * declares (`ChatMemberMember` / `ChatMemberLeft` / `ChatMemberBanned`), so
 * typechecking pins the payload to the real contract.
 */
type BotMemberStatus = "member" | "left" | "kicked";

interface QueuedUpdate {
  update_id: number;
  message?: Record<string, unknown>;
  my_chat_member?: ChatMemberUpdated;
}

interface WireServer {
  url: string;
  close: () => Promise<void>;
  /** Queue one raw Bot API update; resolves only once a poll CONSUMES it. */
  push: (update: QueuedUpdate) => Promise<void>;
  /** Resolves once every queued update has been consumed by getUpdates. */
  waitForDrain: (timeoutMs?: number) => Promise<void>;
  /** Resolves once the service's long-poll has actually queried getUpdates. */
  waitForPoll: (timeoutMs?: number) => Promise<void>;
  /** Mutable member status map served by getChatMember (reconcile seam). */
  memberStatus: Map<string, string>;
  /** Every outbound sendMessage the connector made ({chatId, text}). */
  sentMessages: Array<{ chatId: number; text: string }>;
  /** Every unknown Bot API method the connector called (fail-loud). */
  unsupportedCalls: string[];
  /** Methods the server answered (for assertions on the wire surface). */
  handledMethods: Set<string>;
}

/**
 * Minimal Bot API wire server emulating Telegram's LONG-POLL contract: an
 * empty queue holds the getUpdates request open (50s timeout, like Telegram)
 * instead of returning immediately, so the client never hot-loops. Offset
 * acknowledgement drops consumed updates exactly like Telegram. The only seam
 * replaced is Telegram itself; the Telegraf client on the other end is the
 * production dependency.
 */
async function startWireServer(): Promise<WireServer> {
  const { createServer } = await import("node:http");

  const queue: QueuedUpdate[] = [];
  let offset = 0;
  let pollsServed = 0;
  const pollWaiters: Array<() => void> = [];
  const drainWaiters: Array<() => void> = [];
  /** Held long-polls: each responds with a queue snapshot when woken. */
  const heldPolls: Array<{
    respond: (result: QueuedUpdate[]) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];
  const memberStatus = new Map<string, string>([
    [`${CHAT_ID}:${MEMBER_TG_ID}`, "member"],
    [`${CHAT_ID}:${MEMBER2_TG_ID}`, "member"],
    [`${CHAT_ID}:${BOT_ID}`, "member"],
  ]);
  const sentMessages: Array<{ chatId: number; text: string }> = [];
  const unsupportedCalls: string[] = [];
  const handledMethods = new Set<string>();

  const notifyDrain = (): void => {
    if (queue.length === 0) {
      for (const w of drainWaiters.splice(0)) w();
    }
  };

  /** Wake every held long-poll with the current queue snapshot. */
  const wakeHeldPolls = (): void => {
    const snapshot = queue.slice(0, 100);
    for (const held of heldPolls.splice(0)) {
      clearTimeout(held.timer);
      held.respond(snapshot);
    }
  };

  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", `http://${HOST}`);
      if (process.env.WIRE_DEBUG) {
        console.log(`[wire-server] ${req.method} ${req.url}`);
      }
      const tokenMatch = /\/bot[^/]+\/([A-Za-z]+)$/.exec(url.pathname);
      const method =
        req.method === "GET"
          ? (tokenMatch?.[1] ?? url.pathname.slice(1))
          : tokenMatch?.[1];
      const body: Record<string, unknown> = chunks.length
        ? (JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<
            string,
            unknown
          >)
        : Object.fromEntries(url.searchParams.entries());

      const json = (payload: unknown): void => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      if (!method || !/^[A-Za-z]+$/.test(method)) {
        json({ ok: false, error_code: 404, description: "Not Found" });
        return;
      }
      handledMethods.add(method);

      if (method === "getMe") {
        json({
          ok: true,
          result: {
            id: BOT_ID,
            is_bot: true,
            first_name: "EvidenceBot",
            username: "evidence_local_bot",
            can_join_groups: true,
            can_read_all_group_messages: true,
          },
        });
        return;
      }
      if (method === "getUpdates") {
        pollsServed += 1;
        const requestedOffset = Number(body.offset ?? 0);
        if (requestedOffset > 0) {
          offset = requestedOffset;
          while (queue.length > 0 && queue[0].update_id < offset) {
            queue.shift();
          }
          notifyDrain();
        }
        for (const w of pollWaiters.splice(0)) w();
        if (queue.length === 0) {
          // Hold the long poll open like Telegram does (bounded to 50s). A
          // later push() wakes it with the then-current queue snapshot.
          const timer = setTimeout(() => {
            const index = heldPolls.findIndex((h) => h.timer === timer);
            if (index >= 0) heldPolls.splice(index, 1);
            json({ ok: true, result: [] });
          }, 50_000);
          heldPolls.push({
            respond: (result) => json({ ok: true, result }),
            timer,
          });
          return;
        }
        json({ ok: true, result: queue.slice(0, Number(body.limit ?? 100)) });
        return;
      }
      if (
        method === "setMyCommands" ||
        method === "deleteMessage" ||
        // Telegraf's polling launch clears any webhook FIRST; the long-poll
        // loop never starts unless this succeeds.
        method === "deleteWebhook"
      ) {
        json({ ok: true, result: true });
        return;
      }
      if (method === "sendMessage") {
        sentMessages.push({
          chatId: Number(body.chat_id),
          text: String(body.text ?? ""),
        });
        json({
          ok: true,
          result: {
            message_id: 900_001,
            from: { id: BOT_ID, is_bot: true, first_name: "EvidenceBot" },
            chat: { id: Number(body.chat_id), type: "group" },
            date: Math.floor(Date.now() / 1000),
            text: String(body.text ?? ""),
          },
        });
        return;
      }
      if (method === "getChatMember") {
        const key = `${Number(body.chat_id)}:${Number(body.user_id)}`;
        const status = memberStatus.get(key) ?? "left";
        const user = {
          id: Number(body.user_id),
          is_bot: false,
          first_name: "Member",
        };
        const result =
          status === "kicked"
            ? { status, user, until_date: 0 }
            : status === "restricted"
              ? { status, user, is_member: true, until_date: 0 }
              : { status, user };
        json({ ok: true, result });
        return;
      }
      if (method === "getChat") {
        json({
          ok: true,
          result: { id: CHAT_ID, type: "supergroup", title: "Evidence Group" },
        });
        return;
      }
      // Fail loud on anything outside the emulated surface: a fabricated
      // success here could mask a production client change.
      unsupportedCalls.push(method);
      json({
        ok: false,
        error_code: 404,
        description: `evidence wire server: ${method} not emulated`,
      });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, HOST, resolve));
  const address = server.address();
  if (!address || typeof address !== "object") {
    throw new Error("wire server failed to bind");
  }
  const port = address.port;

  return {
    url: `http://${HOST}:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        for (const held of heldPolls.splice(0)) {
          clearTimeout(held.timer);
          held.respond([]);
        }
        server.close(() => resolve());
      }),
    push: (update) =>
      new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("queued update was never consumed by a poll")),
          20_000,
        );
        drainWaiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
        queue.push(update);
        // Wake held long-polls so the update is delivered immediately.
        wakeHeldPolls();
        notifyDrain();
      }),
    waitForDrain: (timeoutMs = 15_000) =>
      new Promise<void>((resolve, reject) => {
        if (queue.length === 0) return resolve();
        const timer = setTimeout(() => {
          reject(new Error(`wire queue did not drain (${queue.length} left)`));
        }, timeoutMs);
        drainWaiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      }),
    waitForPoll: (timeoutMs = 15_000) =>
      new Promise<void>((resolve, reject) => {
        const snapshot = pollsServed;
        const timer = setTimeout(
          () => reject(new Error("no getUpdates poll arrived")),
          timeoutMs,
        );
        pollWaiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
        // The poll may already have happened (e.g. during service boot).
        if (snapshot > 0) {
          clearTimeout(timer);
          resolve();
        }
      }),
    memberStatus,
    sentMessages,
    unsupportedCalls,
    handledMethods,
  };
}

const CHAT: Chat.SupergroupChat = {
  id: CHAT_ID,
  type: "supergroup",
  title: "Evidence Group",
};

function fromUser(id: number): User {
  return { id, is_bot: false, first_name: `Member${id}` };
}

/**
 * The bot's own chat-member record, typed against the telegraf union so the
 * compiler pins the exact wire shape: `kicked` carries the required
 * `until_date` (`ChatMemberBanned`), `member`/`left` carry only status+user.
 */
function botMemberRecord(status: BotMemberStatus): ChatMember {
  const user: User = {
    id: BOT_ID,
    is_bot: true,
    first_name: "EvidenceBot",
    username: "evidence_local_bot",
  };
  if (status === "kicked") {
    return { status, user, until_date: 0 };
  }
  if (status === "left") {
    return { status, user };
  }
  return { status, user };
}

function textMessage(
  updateId: number,
  fromId: number,
  text: string,
): QueuedUpdate {
  return {
    update_id: updateId,
    message: {
      message_id: updateId * 7,
      from: fromUser(fromId),
      chat: CHAT,
      date: dateFor(updateId),
      text,
    },
  };
}

function memberJoin(
  updateId: number,
  actorId: number,
  joinedId: number,
): QueuedUpdate {
  return {
    update_id: updateId,
    message: {
      message_id: updateId * 7,
      from: fromUser(actorId),
      chat: CHAT,
      date: dateFor(updateId),
      new_chat_members: [fromUser(joinedId)],
    },
  };
}

function memberLeft(updateId: number, leftId: number): QueuedUpdate {
  return {
    update_id: updateId,
    message: {
      message_id: updateId * 7,
      from: fromUser(leftId),
      chat: CHAT,
      date: dateFor(updateId),
      left_chat_member: fromUser(leftId),
    },
  };
}

/** `my_chat_member` transition of the BOT itself, typed against `ChatMemberUpdated`. */
function myChatMember(
  updateId: number,
  fromStatus: BotMemberStatus,
  toStatus: BotMemberStatus,
): QueuedUpdate {
  return {
    update_id: updateId,
    my_chat_member: {
      chat: CHAT,
      from: fromUser(MEMBER_TG_ID),
      date: dateFor(updateId),
      old_chat_member: botMemberRecord(fromStatus),
      new_chat_member: botMemberRecord(toStatus),
    },
  };
}

/** Structural view of the production membership authority (introspection only). */
interface AuthorityView {
  authorize(input: {
    chatId: string;
    chatRoomKey: string;
    canonicalPrincipalId: UUID;
  }): Promise<{
    decision: "allowed" | "denied";
    reason: string;
  }>;
  scopeHealth(input: {
    chatId: string;
    chatRoomKey: string;
  }): Promise<{ health: string; reason?: string } | null>;
}

interface RuntimeHandle {
  harness: ModelProviderTestRuntime;
  runtime: ModelProviderTestRuntime["runtime"];
  service: TelegramService;
  cleanup: () => Promise<void>;
}

const pgliteDirs: string[] = [];
const savedEnv: Record<string, string | undefined> = {};

const ENV_KEYS = [
  "TELEGRAM_API_ROOT",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_AUTO_REPLY",
  "TELEGRAM_MEMBERSHIP_ENFORCE",
  "PGLITE_DATA_DIR",
  "EMBEDDING_DIMENSION",
  "LOCAL_EMBEDDING_DIMENSIONS",
] as const;

/**
 * Boots a real PGLite runtime and starts the REAL TelegramService poller
 * against the wire server. The connector resolves TELEGRAM_API_ROOT /
 * TELEGRAM_BOT_TOKEN through runtime.getSetting's process.env fallback — the
 * same production resolution chain, exercised end to end.
 */
async function bootRuntime(
  pgliteDir: string,
  apiRoot: string,
  fixtures: DeterministicModelFixture[],
): Promise<RuntimeHandle> {
  process.env.TELEGRAM_API_ROOT = apiRoot;
  process.env.TELEGRAM_BOT_TOKEN = BOT_TOKEN;
  process.env.TELEGRAM_AUTO_REPLY = "true";
  process.env.TELEGRAM_MEMBERSHIP_ENFORCE = "true";

  const harness = await createTestRuntimeWithModelProvider({
    pgliteDir,
    removePgliteDirOnCleanup: false,
    characterName: "TelegramEvidenceAgent",
    fixtures: [
      benignExternalMessageFixture("telegram-evidence-security"),
      ...fixtures,
    ],
  });
  const service = await TelegramService.start(harness.runtime);
  const cleanup = async (): Promise<void> => {
    await TelegramService.stop(harness.runtime).catch(() => undefined);
    await service.stop().catch(() => undefined);
    await harness.cleanup();
  };
  boots.push({ cleanup });
  return { harness, runtime: harness.runtime, service, cleanup };
}

/** Live boots this test file; drained by afterEach so every Telegraf
 * poller (and its process-local token claim) is stopped between tests. */
const boots: Array<{ cleanup: () => Promise<void> }> = [];

/**
 * Resolves the settled membership authority for the default account, or null
 * while the gate is still bootstrapping / settled-null (legacy mode).
 */
function getAuthority(handle: RuntimeHandle): AuthorityView | null {
  const gate = (
    handle.service as unknown as {
      settledMembershipGates?: Map<string, { authority: AuthorityView } | null>;
    }
  ).settledMembershipGates?.get(DEFAULT_ACCOUNT_ID);
  return gate ? gate.authority : null;
}

/** Canonical principal id the connector maps a Telegram user to. */
async function principalIdOf(
  handle: RuntimeHandle,
  telegramUserId: number,
): Promise<UUID> {
  return resolveTelegramRuntimeEntityId(
    handle.runtime,
    DEFAULT_ACCOUNT_ID,
    String(telegramUserId),
  );
}

/** Polls `fn` until `ok` holds; throws with the description (and last
 * observed value) on timeout. */
async function until<T>(
  description: string,
  fn: () => Promise<T>,
  ok: (value: T) => boolean,
  timeoutMs = 20_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (ok(value)) return value;
    if (Date.now() > deadline) {
      throw new Error(
        `${description}: condition unmet after ${timeoutMs}ms (last observed: ${JSON.stringify(value)})`,
      );
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

/**
 * Resolves once the default account's membership gate has SETTLED with a
 * live authority (not pending, not the legacy null), so a later denial is
 * attributable to the authority, not a bootstrapping gate.
 */
async function waitForGateReady(
  handle: RuntimeHandle,
  wire: WireServer,
  timeoutMs = 20_000,
): Promise<void> {
  await wire.waitForPoll(timeoutMs);
  await until(
    "membership gate settled with a live authority",
    async () => getAuthority(handle),
    (authority) => authority !== null,
    timeoutMs,
  );
}

/** How one delivered message was treated by the real connector path. */
interface DeliveryOutcome {
  /** Message rows in the chat room's memory table containing the exact inbound text. */
  persistedInbound: number;
  /** Outbound sendMessage calls to the chat during the delivery window. */
  newOutboundReplies: number;
  /** Deterministic-provider model calls during the delivery window. */
  newModelCalls: number;
  /** Room-participant membership state for the sender at delivery time
   * (before the wire push) and after the settle window. Denial legs assert
   * these directly: a revoked participant must remain listed unchanged (no
   * re-add churn), and a never-admitted sender must never appear. */
  wasParticipantBefore: boolean;
  isParticipantAfter: boolean;
  /** The authority's own decision for the sender at classify time. */
  decision: "allowed" | "denied";
  decisionReason: string;
}

/**
 * Delivers one message through the REAL long-poll path and classifies the
 * outcome on independent dimensions: whether the EXACT inbound text was
 * persisted to the chat room's memory (the inbound mutation itself, immune
 * to unrelated-room noise), whether any outbound reply was sent to the chat,
 * deterministic-provider model invocations, and the authority's own
 * authorization decision for the sender. The settle window is a bounded
 * grace period for the middleware chain; event-driven `until` waits are
 * used wherever an expected effect exists to wait for.
 */
async function deliverAndClassify(
  handle: RuntimeHandle,
  wire: WireServer,
  roomId: UUID,
  updateId: number,
  fromId: number,
  text: string,
  settleMs = 6_000,
): Promise<DeliveryOutcome> {
  const authority = getAuthority(handle);
  if (!authority) throw new Error("membership authority not settled");
  const principalId = await principalIdOf(handle, fromId);
  const persistedBefore = await countMemoriesWithText(
    handle.runtime,
    roomId,
    text,
  );
  const callsBefore = modelCallCount(handle);
  const outboundBefore = wire.sentMessages.length;
  const wasParticipantBefore = (
    await handle.runtime.getParticipantsForRoom(roomId)
  ).includes(principalId);
  await wire.push(textMessage(updateId, fromId, text));
  await new Promise((r) => setTimeout(r, settleMs));
  const persistedInbound =
    (await countMemoriesWithText(handle.runtime, roomId, text)) -
    persistedBefore;
  const isParticipantAfter = (
    await handle.runtime.getParticipantsForRoom(roomId)
  ).includes(principalId);
  const decision = await authority.authorize({
    chatId: String(CHAT_ID),
    chatRoomKey: CHAT_KEY,
    canonicalPrincipalId: principalId,
  });
  return {
    persistedInbound,
    newOutboundReplies: wire.sentMessages.length - outboundBefore,
    newModelCalls: modelCallCount(handle) - callsBefore,
    wasParticipantBefore,
    isParticipantAfter,
    decision: decision.decision,
    decisionReason: decision.reason,
  };
}

/** Message rows in a room's memory whose content contains the exact text. */
async function countMemoriesWithText(
  runtime: RuntimeHandle["runtime"],
  roomId: UUID,
  text: string,
): Promise<number> {
  const memories = await runtime.getMemories({
    tableName: "messages",
    roomId,
    count: 1000,
  });
  return memories.filter((m) => String(m.content.text ?? "").includes(text))
    .length;
}

/** Model calls recorded by the deterministic provider since boot. */
function modelCallCount(handle: RuntimeHandle): number {
  return handle.harness.getFixtureDiagnostics().calls.length;
}

/**
 * Single wire server per test (the afterEach drain closes exactly the ones
 * still open; explicit closes mid-test are idempotent no-ops on their maps).
 */
let wireRef: WireServer | null = null;

/**
 * Throws a PRECISE error unless admission resumed for the given message:
 * the EXACT inbound text is persisted AND the authority allows the sender.
 * Used inside the `it.fails` tripwire, where the thrown message is the
 * deadlock evidence.
 */
async function assertAdmissionResumedOrThrow(
  handle: RuntimeHandle,
  roomId: UUID,
  fromId: number,
  updateId: number,
  text: string,
): Promise<void> {
  const wire = wireRef;
  if (!wire) throw new Error("wire server not running");
  await wire.push(textMessage(updateId, fromId, text));
  const persisted = await until(
    "admission resumption (expected to stay blocked at the PR head)",
    async () => countMemoriesWithText(handle.runtime, roomId, text),
    (count) => count > 0,
    6_000,
  ).catch(() => 0);
  if (persisted > 0) return;
  const authority = getAuthority(handle);
  const principalId = await principalIdOf(handle, fromId);
  const decision = authority
    ? await authority.authorize({
        chatId: String(CHAT_ID),
        chatRoomKey: CHAT_KEY,
        canonicalPrincipalId: principalId,
      })
    : null;
  throw new Error(
    `admission never resumed: "${text}" was never persisted, authority decision ${decision ? `${decision.decision}/${decision.reason}` : "unsettled"} (persisted scope health stays unavailable after bot re-add; the gate blocks the join evidence that would restore it)`,
  );
}

beforeAll(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
});

afterEach(async () => {
  // Drain EVERY live boot first: TelegramService.stop releases the
  // process-local poller token claim, without which the next test's boot
  // fails with a poller ownership conflict on the same bot token.
  while (boots.length > 0) {
    const boot = boots.pop();
    if (boot) await boot.cleanup().catch(() => undefined);
  }
  if (wireRef) {
    await wireRef.close().catch(() => undefined);
    wireRef = null;
  }
});

afterAll(async () => {
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  // Remove PGLite fixture databases after runtimes have been cleaned up.
  const { rm } = await import("node:fs/promises");
  for (const dir of pgliteDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

describe("telegram membership lifecycle over the real long-poll connector (keyless wire server)", () => {
  it("admits, revokes, denies pre-mutation, survives restart, and restores on re-add", async () => {
    const { mkdtemp } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
    const pgliteDir = await mkdtemp(path.join(tmpdir(), "tg-poller-evidence-"));
    pgliteDirs.push(pgliteDir);

    wireRef = await startWireServer();
    const wire = wireRef;

    const replyFixture: DeterministicModelFixture = {
      name: "evidence-reply",
      match: { modelType: ModelType.RESPONSE_HANDLER },
      response: {
        contexts: ["simple"],
        intents: [],
        replyText: "evidence reply from the deterministic provider",
        candidateActionNames: [],
      },
    };

    // ── Boot #1: the REAL TelegramService long-polls our wire server. ──
    const boot1 = await bootRuntime(pgliteDir, wire.url, [replyFixture]);
    await waitForGateReady(boot1, wire);
    // The production poller must subscribe to my_chat_member; nothing
    // outside the emulated wire surface may ever be called.
    expect(wire.unsupportedCalls).toEqual([]);
    expect(wire.handledMethods.has("getUpdates")).toBe(true);

    const authority1 = getAuthority(boot1);
    if (!authority1) throw new Error("authority missing after gate ready");
    const roomId = createUniqueUuid(boot1.runtime, `${CHAT_ID}`) as UUID;
    const principal1 = await principalIdOf(boot1, MEMBER_TG_ID);
    const principal2 = await principalIdOf(boot1, MEMBER2_TG_ID);

    // ── 1. Admitted member message via REAL message-path evidence: a join
    // update (carried by the still-valid member themselves — Telegram's
    // actual self-join shape) lands join evidence first, then their text
    // message is admitted by it (NOT by the reconcile fallback — the wire
    // getChatMember map is only a point-query seam). ──
    await wire.push(memberJoin(10_100, MEMBER_TG_ID, MEMBER_TG_ID));
    await until(
      "join evidence admitted the member in the authority",
      async () =>
        authority1.authorize({
          chatId: String(CHAT_ID),
          chatRoomKey: CHAT_KEY,
          canonicalPrincipalId: principal1,
        }),
      (decision) => decision.decision === "allowed",
    );
    await wire.push(
      textMessage(10_101, MEMBER_TG_ID, "hello from an admitted member"),
    );
    await until(
      "admitted member message reached memory through the real connector",
      async () =>
        countMemoriesWithText(
          boot1.runtime,
          roomId,
          "hello from an admitted member",
        ),
      (count) => count > 0,
    );
    // Non-vacuity guard for the participant dimension: while admitted, the
    // sender IS a recorded participant of the room — so the cleared state
    // asserted after revocation is a real transition, not a never-listed
    // artifact.
    await until(
      "admitted member is a recorded room participant",
      async () =>
        (await boot1.runtime.getParticipantsForRoom(roomId)).includes(
          principal1,
        ),
      (listed) => listed === true,
    );

    // ── 2. Removal/revocation: the member leaves the chat. The authority
    // must flip to a durable denied BEFORE we test the message path, so
    // the next denial is attributable to the persisted revocation. ──
    await wire.push(memberLeft(10_102, MEMBER_TG_ID));
    const revoked = await until(
      "member-leave revocation landed in the authority",
      async () =>
        authority1.authorize({
          chatId: String(CHAT_ID),
          chatRoomKey: CHAT_KEY,
          canonicalPrincipalId: principal1,
        }),
      (decision) =>
        decision.decision === "denied" &&
        decision.reason === "membership_revoked",
    );
    expect(revoked.decision).toBe("denied");

    // Participation clear is part of the same leave handling as the durable
    // revocation; wait for it explicitly so the denial leg below asserts a
    // settled pre-state, not a race between the two writes.
    await until(
      "member-leave cleared the departed member's room participation",
      async () =>
        (await boot1.runtime.getParticipantsForRoom(roomId)).includes(
          principal1,
        ),
      (stillListed) => stillListed === false,
    );

    // ── 3. Next message denied BEFORE any mutation: the exact inbound text
    // must never be persisted, no outbound reply may be sent, the model
    // must not run, and the authority itself must deny for exactly this
    // reason. ──
    const denied = await deliverAndClassify(
      boot1,
      wire,
      roomId,
      10_103,
      MEMBER_TG_ID,
      "message after revocation",
    );
    expect(
      denied.persistedInbound,
      "revoked sender's message never reached memory",
    ).toBe(0);
    expect(
      denied.newOutboundReplies,
      "no outbound reply for the denied message",
    ).toBe(0);
    expect(
      denied.newModelCalls,
      "the model provider was never invoked for the denied message",
    ).toBe(0);
    expect(denied.decision).toBe("denied");
    expect(denied.decisionReason).toBe("membership_revoked");
    // Participant dimension of "denied BEFORE participant/memory/model
    // mutation": the revoked sender's cleared participation row must neither
    // be re-added nor otherwise churned by the denied delivery itself.
    expect(
      denied.wasParticipantBefore,
      "revocation had cleared the sender's participation before the message",
    ).toBe(false);
    expect(
      denied.isParticipantAfter,
      "the denied message did not re-add or mutate the sender's participation",
    ).toBe(false);

    // A second, still-valid member keeps working: the revocation is scoped.
    await wire.push(textMessage(10_104, MEMBER2_TG_ID, "still a member here"));
    await until(
      "unrevoked member unaffected by the other member's revocation",
      async () =>
        countMemoriesWithText(boot1.runtime, roomId, "still a member here"),
      (count) => count > 0,
    );

    // ── 4. Restart: stop the service + runtime, keep the PGLite dir. ──
    await boot1.cleanup();

    const boot2 = await bootRuntime(pgliteDir, wire.url, [replyFixture]);
    await waitForGateReady(boot2, wire);
    const authority2 = getAuthority(boot2);
    if (!authority2) throw new Error("authority missing after restart");

    // Durability pre-checks BEFORE the restart denial: the persisted scope
    // must be current again, the still-valid member must be allowed, and
    // the departed member's revocation must have survived — otherwise a
    // denial could be blamed on a still-bootstrapping or stale scope.
    await until(
      "persisted scope health returned to current after restart",
      async () =>
        authority2.scopeHealth({
          chatId: String(CHAT_ID),
          chatRoomKey: CHAT_KEY,
        }),
      (health) => health?.health === "current",
    );
    const member2AfterRestart = await authority2.authorize({
      chatId: String(CHAT_ID),
      chatRoomKey: CHAT_KEY,
      canonicalPrincipalId: principal2,
    });
    expect(
      member2AfterRestart.decision,
      "still-valid member allowed from persisted evidence after restart",
    ).toBe("allowed");
    const revokedAfterRestart = await authority2.authorize({
      chatId: String(CHAT_ID),
      chatRoomKey: CHAT_KEY,
      canonicalPrincipalId: principal1,
    });
    expect(revokedAfterRestart.decision).toBe("denied");
    expect(revokedAfterRestart.reason).toBe("membership_revoked");

    const roomId2 = createUniqueUuid(boot2.runtime, `${CHAT_ID}`) as UUID;

    // ── 5. Denial remains after restart (durable revocation). ──
    const deniedRestart = await deliverAndClassify(
      boot2,
      wire,
      roomId2,
      10_105,
      MEMBER_TG_ID,
      "after restart, still revoked",
    );
    expect(
      deniedRestart.persistedInbound,
      "revocation survived the restart — still denied pre-mutation",
    ).toBe(0);
    expect(deniedRestart.newOutboundReplies).toBe(0);
    expect(deniedRestart.newModelCalls).toBe(0);
    expect(deniedRestart.decisionReason).toBe("membership_revoked");
    // Participant dimension, post-restart leg: the durable revocation keeps
    // the sender out of the room's participant set and the denied delivery
    // still does not mutate participation.
    expect(deniedRestart.isParticipantAfter).toBe(false);

    // ── 6. Re-add + fresh evidence: a STILL-VALID member adds the departed
    // member back (Telegram's actual shape: `from` is the adder). The
    // authority must readmit from the join evidence BEFORE the message
    // leg, proving restoration is evidence-driven, not message-driven. ──
    await wire.push(memberJoin(10_106, MEMBER2_TG_ID, MEMBER_TG_ID));
    await until(
      "fresh join evidence readmitted the re-added principal",
      async () =>
        authority2.authorize({
          chatId: String(CHAT_ID),
          chatRoomKey: CHAT_KEY,
          canonicalPrincipalId: principal1,
        }),
      (decision) => decision.decision === "allowed",
    );

    // ── 7. Admission restored: the exact inbound text is persisted again. ──
    await wire.push(
      textMessage(10_107, MEMBER_TG_ID, "fresh evidence, admit me again"),
    );
    await until(
      "fresh post-re-add evidence restored admission through the real connector",
      async () =>
        countMemoriesWithText(
          boot2.runtime,
          roomId2,
          "fresh evidence, admit me again",
        ),
      (count) => count > 0,
    );

    // The wire server must never have answered an unemulated method.
    expect(wire.unsupportedCalls).toEqual([]);
  }, 240_000);

  it("tombstones the whole scope when the bot itself is kicked (fail-closed)", async () => {
    const { mkdtemp } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
    const pgliteDir = await mkdtemp(
      path.join(tmpdir(), "tg-poller-tombstone-"),
    );
    pgliteDirs.push(pgliteDir);

    wireRef = await startWireServer();
    const wire = wireRef;
    const replyFixture: DeterministicModelFixture = {
      name: "tombstone-reply",
      match: { modelType: ModelType.RESPONSE_HANDLER },
      response: {
        contexts: ["simple"],
        intents: [],
        replyText: "tombstone proof reply",
        candidateActionNames: [],
      },
    };

    const boot = await bootRuntime(pgliteDir, wire.url, [replyFixture]);
    await waitForGateReady(boot, wire);
    const authority = getAuthority(boot);
    if (!authority) throw new Error("authority missing after gate ready");

    const roomId = createUniqueUuid(boot.runtime, `${CHAT_ID}`) as UUID;
    const scopeArgs = { chatId: String(CHAT_ID), chatRoomKey: CHAT_KEY };

    // Valid member establishes join evidence + speaks while the bot is
    // present (message-path admission, not reconcile).
    await wire.push(memberJoin(20_100, MEMBER_TG_ID, MEMBER_TG_ID));
    await until(
      "join evidence admitted the member before the kick",
      async () =>
        authority.authorize({
          ...scopeArgs,
          canonicalPrincipalId: await principalIdOf(boot, MEMBER_TG_ID),
        }),
      (decision) => decision.decision === "allowed",
    );
    await wire.push(
      textMessage(20_101, MEMBER_TG_ID, "before the bot is kicked"),
    );
    await until(
      "member message reached memory before the kick",
      async () =>
        countMemoriesWithText(boot.runtime, roomId, "before the bot is kicked"),
      (count) => count > 0,
    );

    // The BOT is kicked: my_chat_member revoked transition → the persisted
    // scope health must degrade to unavailable before the denial leg.
    await wire.push(myChatMember(20_102, "member", "kicked"));
    const degraded = await until(
      "scope health degraded to unavailable after the bot kick",
      async () => authority.scopeHealth(scopeArgs),
      (health) => health?.health === "unavailable",
    );
    expect(degraded?.reason).toBe("bot_removed");

    // Every member is now denied pre-mutation: the scope fails closed (a
    // kicked bot cannot observe the chat, so stale evidence must not
    // authorize). Classified on all four dimensions.
    const denied = await deliverAndClassify(
      boot,
      wire,
      roomId,
      20_103,
      MEMBER2_TG_ID,
      "after the bot was kicked",
    );
    expect(denied.persistedInbound).toBe(0);
    expect(denied.newOutboundReplies).toBe(0);
    expect(denied.newModelCalls).toBe(0);
    expect(denied.decision).toBe("denied");
    expect(denied.decisionReason).toBe("authority_unavailable");
    expect(wire.unsupportedCalls).toEqual([]);
  }, 240_000);

  it.fails("bot re-add + fresh join evidence restores admission for a still-valid member (KNOWN deadlock at the PR head)", async () => {
    // KNOWN connector-path recovery deadlock, pinned so a fix flips this
    // tripwire green: after a bot kick, `my_chat_member` revoked→present
    // clears the IN-MEMORY tombstone, but the PERSISTED scope health stays
    // `unavailable`. The middleware admission gate denies every group
    // update while scope health is degraded — including the join updates
    // that carry the fresh evidence which would advance the scope back to
    // `current` — and `authority_unavailable` is not in the gate's
    // reconcile-miss set (RECONCILE_MISS_REASONS). The scope can therefore
    // never recover through the connector until something external resets
    // it. Member-level revocation recovery (no bot kick) DOES work; see
    // the lifecycle test above.
    //
    // Companion-test discipline: this file's first (green) test uses the
    // SAME harness (same boot, same fixtures, same wire server) and
    // proves it admits messages, so the throw below is attributable to
    // the deadlock rather than a broken boot; if the harness breaks, the
    // companion fails normally while this tripwire stays red.
    const { mkdtemp } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
    const pgliteDir = await mkdtemp(path.join(tmpdir(), "tg-poller-botreadd-"));
    pgliteDirs.push(pgliteDir);

    wireRef = await startWireServer();
    const wire = wireRef;
    const replyFixture: DeterministicModelFixture = {
      name: "botreadd-reply",
      match: { modelType: ModelType.RESPONSE_HANDLER },
      response: {
        contexts: ["simple"],
        intents: [],
        replyText: "bot re-add proof reply",
        candidateActionNames: [],
      },
    };

    const boot = await bootRuntime(pgliteDir, wire.url, [replyFixture]);
    await waitForGateReady(boot, wire);
    const authority = getAuthority(boot);
    if (!authority) throw new Error("authority missing after gate ready");

    const roomId = createUniqueUuid(boot.runtime, `${CHAT_ID}`) as UUID;
    const scopeArgs = { chatId: String(CHAT_ID), chatRoomKey: CHAT_KEY };

    // Baseline: the member joins (message-path evidence) and speaks, so
    // the final failure below cannot be blamed on a cold harness.
    await wire.push(memberJoin(30_200, MEMBER_TG_ID, MEMBER_TG_ID));
    await until(
      "join evidence admitted the member before the kick",
      async () =>
        authority.authorize({
          ...scopeArgs,
          canonicalPrincipalId: await principalIdOf(boot, MEMBER_TG_ID),
        }),
      (decision) => decision.decision === "allowed",
    );
    await wire.push(textMessage(30_201, MEMBER_TG_ID, "admit me first"));
    await until(
      "baseline admission before the kick",
      async () => countMemoriesWithText(boot.runtime, roomId, "admit me first"),
      (count) => count > 0,
    );

    // Kick the bot (persisted scope degrades), then re-add it (clears the
    // in-memory tombstone only, at the PR head).
    await wire.push(myChatMember(30_202, "member", "kicked"));
    await until(
      "scope health degraded after the bot kick",
      async () => authority.scopeHealth(scopeArgs),
      (health) => health?.health === "unavailable",
    );
    await wire.push(myChatMember(30_203, "kicked", "member"));
    await new Promise((r) => setTimeout(r, 1_500));

    // A member join carried by a STILL-VALID adder should land fresh
    // evidence and restore the scope — at the PR head the gate blocks it.
    await wire.push(memberJoin(30_204, MEMBER_TG_ID, MEMBER2_TG_ID));
    await new Promise((r) => setTimeout(r, 1_500));

    // THE assertion: admission must have resumed on fresh evidence. At the
    // PR head this throws with the precise deadlock signature (memory and
    // model-call deltas flat, authority still denying).
    await assertAdmissionResumedOrThrow(
      boot,
      roomId,
      MEMBER2_TG_ID,
      30_205,
      "fresh evidence, admit me again",
    );
  }, 240_000);
});
