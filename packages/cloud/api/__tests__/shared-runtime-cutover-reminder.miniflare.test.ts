/**
 * Runs the production Shared conversation coordinator in Workerd and proves a
 * committed Personal Shared -> Dedicated cutover cannot reopen Shared for a
 * reminder turn. Network cases exercise actual DO scope/history/claim storage
 * and actual Shared bridge early replay/conflict; seeded receipts and transport
 * probes are not generated model/provider completions.
 */

import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Miniflare } from "miniflare";
import {
  type NetworkAppId,
  networkMembershipScopeId,
} from "../../shared/src/lib/services/shared-runtime/network-membership-client";
import type {
  NetworkSharedTurnContext,
  NetworkSharedTurnObservation,
} from "../../shared/src/lib/services/shared-runtime/network-shared-context";
import { personalSharedAgentId } from "../../shared/src/lib/services/shared-runtime/personal-shared-identity";
import {
  SharedRuntimeChatService,
  type SharedRuntimeHistoryStore,
  type SharedTurnClaimStore,
  type SharedTurnTerminalResult,
  sharedRuntimeRoomKey,
} from "../../shared/src/lib/services/shared-runtime/shared-runtime-chat";

const RUNTIME_BOUNDARIES = {
  fallbackAuthority:
    /packages[\\/]cloud[\\/]shared[\\/]src[\\/]lib[\\/]services[\\/]personal-dedicated-fallback\.ts$/,
  apiErrors:
    /packages[\\/]cloud[\\/]shared[\\/]src[\\/]lib[\\/]api[\\/]errors\.ts$/,
  apnsProvider:
    /packages[\\/]cloud[\\/]shared[\\/]src[\\/]lib[\\/]mobile-push[\\/]apns-provider\.ts$/,
  databaseClient:
    /packages[\\/]cloud[\\/]shared[\\/]src[\\/]db[\\/]client\.ts$/,
  historyRepository:
    /packages[\\/]cloud[\\/]shared[\\/]src[\\/]db[\\/]repositories[\\/]shared-runtime-history\.ts$/,
  logger:
    /packages[\\/]cloud[\\/]shared[\\/]src[\\/]lib[\\/]utils[\\/]logger\.ts$/,
  sharedElizaRuntime:
    /packages[\\/]cloud[\\/]shared[\\/]src[\\/]lib[\\/]services[\\/]shared-runtime[\\/]shared-eliza-runtime\.ts$/,
  sharedRuntimeChat:
    /packages[\\/]cloud[\\/]shared[\\/]src[\\/]lib[\\/]services[\\/]shared-runtime[\\/]shared-runtime-chat\.ts$/,
  sharedRuntimeErrors:
    /packages[\\/]cloud[\\/]shared[\\/]src[\\/]lib[\\/]services[\\/]shared-runtime[\\/]shared-runtime-errors\.ts$/,
  cachedAgentDates:
    /packages[\\/]cloud[\\/]shared[\\/]src[\\/]lib[\\/]services[\\/]shared-runtime[\\/]cached-agent-dates\.ts$/,
  tierUpgradeTarget:
    /packages[\\/]cloud[\\/]shared[\\/]src[\\/]lib[\\/]services[\\/]agent-tier-upgrade-target\.ts$/,
} as const;

const RUNTIME_STUBS = {
  fallbackAuthority: `
    export async function resolvePersonalFallbackCutoverRecovery() {
      const response = await fetch("https://fallback-authority.test/state");
      return await response.json();
    }
  `,
  apiErrors: `
    export class InsufficientCreditsError extends Error {}
    export class RateLimitError extends Error {}
  `,
  apnsProvider: `
    export function resolveCloudApnsConfig() { return null; }
    export class CloudApnsProvider {
      async send() { throw new Error("APNs is outside this cutover test"); }
    }
  `,
  cachedAgentDates: `
    export function rehydrateCachedAgentDates(agent) { return agent; }
  `,
  coreEdge: `
    export { MediaFetchError, readResponseWithLimit } from ${JSON.stringify(
      fileURLToPath(
        new URL("../../../core/src/media/fetch.ts", import.meta.url),
      ),
    )};
    export { trimEndCharacters } from ${JSON.stringify(
      fileURLToPath(
        new URL(
          "../../../core/src/utils/string-boundaries.ts",
          import.meta.url,
        ),
      ),
    )};
    export { isSensitiveKeyName, redactSensitiveText } from ${JSON.stringify(
      fileURLToPath(
        new URL("../../../core/src/security/redact.ts", import.meta.url),
      ),
    )};
    export class ElizaError extends Error {}
    export const ChannelType = {
      SELF: "SELF",
      DM: "DM",
      GROUP: "GROUP",
      VOICE_DM: "VOICE_DM",
      VOICE_GROUP: "VOICE_GROUP",
      FEED: "FEED",
      THREAD: "THREAD",
      WORLD: "WORLD",
      FORUM: "FORUM",
      AUTONOMOUS: "AUTONOMOUS",
      API: "API",
    };
    export function isBlockedHostname() { return false; }
    export function isPrivateIpAddress() { return false; }
    export function stringToUuid(value) {
      const suffix = String(value).length.toString(16).padStart(12, "0").slice(-12);
      return "00000000-0000-5000-8000-" + suffix;
    }
  `,
  databaseClient: `
    export async function runWithDbCacheAsync(operation) {
      return await operation();
    }
  `,
  historyRepository: `
    export const sharedRuntimeHistoryRepository = {
      async get() { return []; },
      async merge() {},
      async deleteByAgent() {},
    };
  `,
  logger: `
    export const logger = {
      debug() {}, info() {}, warn() {}, error() {},
    };
  `,
  sharedElizaRuntime: "export async function prewarmSharedElizaRuntime() {}",
  sharedRuntimeChat: `
    export const sharedRuntimeChatService = {
      async getHistory(agentId, roomId, store) {
        return await store.load(agentId, roomId);
      },
      async bridge(agent, rpc, options) {
        if (rpc.id === "network-transport-probe") {
          return { jsonrpc: "2.0", id: rpc.id, result: { observation: options.trustedNetworkContext ?? null, roomId: rpc.params.roomId } };
        }
        if (rpc.id === "fallback-account-state") {
          // Echo the server-owned options the coordinator admitted, plus the
          // exact history the turn would load for its room.
          const history = await options.historyStore.load(agent.id, rpc.params.roomId);
          return {
            jsonrpc: "2.0",
            id: rpc.id,
            result: {
              text: JSON.stringify({
                accountState: options.trustedAccountState ?? null,
                funding: options.funding,
                history,
              }),
            },
          };
        }
        await fetch("https://model-probe.test/v1/chat/completions", {
          method: "POST",
          body: "unexpected-shared-reminder-inference",
        });
        throw new Error("Committed cutover reached Shared inference");
      },
      async stream(agent, rpc, options) {
        if (rpc.id === "fallback-account-state-stream") {
          // Echo the server-owned account state the streaming turn admitted.
          const body = JSON.stringify({
            accountState: options.trustedAccountState ?? null,
            funding: options.funding,
          });
          return new Response("event: done\\ndata: " + body + "\\n\\n", {
            headers: { "content-type": "text/event-stream" },
          });
        }
        if (rpc.id === "barge-eviction") {
          const roomId = rpc.params.roomId;
          const interrupted = [
            {
              id: "workerd-interrupted-user",
              role: "user",
              content: rpc.params.text,
              createdAt: 1787184001000,
            },
            {
              id: "workerd-interrupted-assistant",
              role: "assistant",
              content: "partial answer",
              createdAt: 1787184001001,
              interrupted: true,
            },
          ];
          return new Response(new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("event: chunk\\ndata: {}\\n\\n"));
            },
            async cancel() {
              options.historyStore.stagePending(agent.id, roomId, interrupted);
              options.executionCtx.waitUntil((async () => {
                const response = await fetch("https://finalization-gate.test/wait");
                // Drain the outbound body so the fixture does not retain a
                // Workerd reference while the test evicts the Durable Object.
                await response.text();
                throw new Error("simulated off-queue finalization failure");
              })());
            },
          }), { headers: { "content-type": "text/event-stream" } });
        }
        await fetch("https://model-probe.test/v1/chat/completions", {
          method: "POST",
          body: "unexpected-shared-reminder-inference",
        });
        throw new Error("Committed cutover reached Shared inference");
      },
      async recordLifecycleEvent() {
        throw new Error("Lifecycle writes are outside this cutover test");
      },
    };
  `,
  sharedRuntimeErrors: "export class SharedRuntimeTurnError extends Error {}",
  tierUpgradeTarget:
    "export async function findActivePersonalDedicatedTarget() { return null; }",
} as const;

describe("Personal Shared cutover reminder containment in Workerd", () => {
  let buildDirectory: string;
  let miniflare: Miniflare;
  const modelRequests: string[] = [];
  let fallbackResolution = "pending";
  let fallbackAuthorityReads = 0;
  let releaseFinalizationGate = () => {};
  const finalizationGate = new Promise<void>((resolve) => {
    releaseFinalizationGate = resolve;
  });

  beforeAll(async () => {
    const apiDirectory = fileURLToPath(new URL("../", import.meta.url));
    buildDirectory = await mkdtemp(
      join(tmpdir(), "shared-cutover-reminder-workerd-"),
    );
    const coordinatorSource = fileURLToPath(
      new URL("../src/shared-runtime-conversation.ts", import.meta.url),
    );
    const sharedSourceDirectory = fileURLToPath(
      new URL("../../shared/src/", import.meta.url),
    );
    const entrypoint = join(buildDirectory, "worker.ts");
    await Bun.write(
      entrypoint,
      `
        import { SharedRuntimeConversation } from ${JSON.stringify(coordinatorSource)};

        export class TestSharedRuntimeConversation extends SharedRuntimeConversation {
          constructor(state, env) {
            super(state, env);
            this.testState = state;
          }

          async fetch(request) {
            if (new URL(request.url).pathname === "/__test/claims") {
              const body = await request.json();
              const claims = this.turnClaims();
              const decision = await claims.claim(body.key, body.hash);
              if (decision.state === "claimed" && body.seedResult) {
                await claims.complete(body.key, body.seedResult);
                return Response.json(await claims.claim(body.key, body.hash));
              }
              return Response.json(decision);
            }
            if (new URL(request.url).pathname === "/__test/history-store") {
              const body = await request.json();
              const store = this.historyStore(true);
              return Response.json(body.messages
                ? await store.merge(body.agentId, body.channelId, body.messages)
                : await store.load(body.agentId, body.channelId));
            }
            if (new URL(request.url).pathname === "/__test/seed") {
              const body = await request.json();
              await this.testState.storage.put("conversation", body.conversation);
              return Response.json({ success: true });
            }
            if (new URL(request.url).pathname === "/__test/barge") {
              const response = await super.fetch(new Request(
                "https://runtime.test/stream",
                {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: await request.text(),
                },
              ));
              const reader = response.body.getReader();
              await reader.read();
              await reader.cancel("barge-in");
              return Response.json({ success: true });
            }
            return await super.fetch(request);
          }
        }

        export default {
          async fetch(request, env) {
            const name = request.headers.get("x-test-room");
            if (!name) return new Response("missing room", { status: 400 });
            const id = env.SHARED_RUNTIME_CONVERSATIONS.idFromName(name);
            const stub = env.SHARED_RUNTIME_CONVERSATIONS.get(id);
            return await stub.fetch(request);
          },
        };
      `,
    );

    const outputPath = join(buildDirectory, "worker.mjs");
    const buildScriptPath = join(buildDirectory, "build-worker.mjs");
    await Bun.write(
      buildScriptPath,
      `
        import { join } from "node:path";

        const boundary = (source) => new RegExp(source);
        const result = await Bun.build({
          entrypoints: [process.env.SHARED_CUTOVER_ENTRYPOINT],
          format: "esm",
          target: "browser",
          conditions: ["eliza-source", "worker", "browser"],
          external: ["node:*"],
          plugins: [{
            name: "shared-cutover-reminder-runtime-boundaries",
            setup(build) {
              build.onResolve({ filter: /^@elizaos\\/core(?:\\/edge)?$/ }, () => ({
                path: "core-edge",
                namespace: "shared-cutover-test-stub",
              }));
              build.onLoad(
                { filter: /^core-edge$/, namespace: "shared-cutover-test-stub" },
                () => ({ loader: "ts", contents: ${JSON.stringify(RUNTIME_STUBS.coreEdge)} }),
              );
              build.onResolve({ filter: /^@\\/(?:db|lib|types)\\// }, (args) => ({
                path: join(
                  process.env.SHARED_CUTOVER_SHARED_SOURCE,
                  args.path.slice(2) + ".ts",
                ),
              }));
              build.onLoad(
                { filter: boundary(${JSON.stringify(RUNTIME_BOUNDARIES.databaseClient.source)}) },
                () => ({ loader: "ts", contents: ${JSON.stringify(RUNTIME_STUBS.databaseClient)} }),
              );
              build.onLoad(
                { filter: boundary(${JSON.stringify(RUNTIME_BOUNDARIES.sharedRuntimeChat.source)}) },
                () => ({ loader: "ts", contents: ${JSON.stringify(RUNTIME_STUBS.sharedRuntimeChat)} }),
              );
              build.onLoad(
                { filter: boundary(${JSON.stringify(RUNTIME_BOUNDARIES.sharedRuntimeErrors.source)}) },
                () => ({ loader: "ts", contents: ${JSON.stringify(RUNTIME_STUBS.sharedRuntimeErrors)} }),
              );
              build.onLoad(
                { filter: boundary(${JSON.stringify(RUNTIME_BOUNDARIES.cachedAgentDates.source)}) },
                () => ({ loader: "ts", contents: ${JSON.stringify(RUNTIME_STUBS.cachedAgentDates)} }),
              );
              build.onLoad(
                { filter: boundary(${JSON.stringify(RUNTIME_BOUNDARIES.sharedElizaRuntime.source)}) },
                () => ({ loader: "ts", contents: ${JSON.stringify(RUNTIME_STUBS.sharedElizaRuntime)} }),
              );
              build.onLoad(
                { filter: boundary(${JSON.stringify(RUNTIME_BOUNDARIES.historyRepository.source)}) },
                () => ({ loader: "ts", contents: ${JSON.stringify(RUNTIME_STUBS.historyRepository)} }),
              );
              build.onLoad(
                { filter: boundary(${JSON.stringify(RUNTIME_BOUNDARIES.fallbackAuthority.source)}) },
                () => ({ loader: "ts", contents: ${JSON.stringify(RUNTIME_STUBS.fallbackAuthority)} }),
              );
              build.onLoad(
                { filter: boundary(${JSON.stringify(RUNTIME_BOUNDARIES.tierUpgradeTarget.source)}) },
                () => ({ loader: "ts", contents: ${JSON.stringify(RUNTIME_STUBS.tierUpgradeTarget)} }),
              );
              build.onLoad(
                { filter: boundary(${JSON.stringify(RUNTIME_BOUNDARIES.logger.source)}) },
                () => ({ loader: "ts", contents: ${JSON.stringify(RUNTIME_STUBS.logger)} }),
              );
              build.onLoad(
                { filter: boundary(${JSON.stringify(RUNTIME_BOUNDARIES.apnsProvider.source)}) },
                () => ({ loader: "ts", contents: ${JSON.stringify(RUNTIME_STUBS.apnsProvider)} }),
              );
              build.onLoad(
                { filter: boundary(${JSON.stringify(RUNTIME_BOUNDARIES.apiErrors.source)}) },
                () => ({ loader: "ts", contents: ${JSON.stringify(RUNTIME_STUBS.apiErrors)} }),
              );
            },
          }],
        });
        if (!result.success) {
          for (const log of result.logs) console.error(log);
          process.exit(1);
        }
        const output = result.outputs[0];
        if (!output) throw new Error("Shared cutover test Worker was not emitted");
        await Bun.write(process.env.SHARED_CUTOVER_OUTPUT, output);
      `,
    );
    const bundle = Bun.spawn({
      cmd: [process.execPath, buildScriptPath],
      cwd: apiDirectory,
      env: {
        ...process.env,
        SHARED_CUTOVER_ENTRYPOINT: entrypoint,
        SHARED_CUTOVER_OUTPUT: outputPath,
        SHARED_CUTOVER_SHARED_SOURCE: sharedSourceDirectory,
      },
      stderr: "pipe",
      stdout: "pipe",
    });
    const [bundleExitCode, bundleStderr, bundleStdout] = await Promise.all([
      bundle.exited,
      new Response(bundle.stderr).text(),
      new Response(bundle.stdout).text(),
    ]);
    if (bundleExitCode !== 0) {
      throw new Error(
        `Failed to bundle Shared cutover reminder test Worker:\n${bundleStderr}${bundleStdout}`,
      );
    }
    miniflare = new Miniflare({
      compatibilityDate: "2026-06-01",
      compatibilityFlags: ["nodejs_compat"],
      modules: true,
      script: await readFile(outputPath, "utf8"),
      outboundService: async (request: Request) => {
        if (new URL(request.url).hostname === "fallback-authority.test") {
          fallbackAuthorityReads += 1;
          return Response.json(fallbackResolution);
        }
        if (new URL(request.url).hostname === "finalization-gate.test") {
          await finalizationGate;
          return new Response("released");
        }
        modelRequests.push(request.url);
        return Response.json(
          { error: "unexpected inference" },
          { status: 500 },
        );
      },
      durableObjects: {
        SHARED_RUNTIME_CONVERSATIONS: {
          className: "TestSharedRuntimeConversation",
          useSQLite: true,
        },
      },
    });
  }, 120_000);

  afterAll(async () => {
    releaseFinalizationGate();
    await miniflare?.dispose();
    if (buildDirectory) await rm(buildDirectory, { recursive: true });
  });

  async function post(
    room: string,
    path: string,
    body: Record<string, unknown>,
  ) {
    return await miniflare.dispatchFetch(`https://runtime.test${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-test-room": room,
      },
      body: JSON.stringify(body),
    });
  }

  test("a committed seal rejects a reminder before history mutation or inference", async () => {
    const personalAgent = {
      id: "personal:cutover-reminder-miniflare",
      organization_id: "organization-cutover-miniflare",
      user_id: "user-cutover-miniflare",
      character_id: null,
      agent_name: "Eliza",
      agent_config: { character: { name: "Eliza" } },
      execution_tier: "shared",
    };
    const history = [
      {
        id: "turn-before-cutover",
        role: "user",
        content: "This conversation belongs to Shared before cutover.",
        createdAt: 1_787_184_000_000,
      },
    ];
    const token = "personal-cutover:source:dedicated";

    const seeded = await post(personalAgent.id, "/__test/seed", {
      conversation: {
        agentId: personalAgent.id,
        channelId: personalAgent.id,
        history,
        dirty: false,
        version: 1,
      },
    });
    expect(seeded.status, await seeded.text()).toBe(200);

    const sealed = await post(personalAgent.id, "/cutover-seal", {
      operation: "cutover-seal",
      agentId: personalAgent.id,
      roomId: personalAgent.id,
      token,
      leaseMs: 60_000,
      organizationId: personalAgent.organization_id,
      userId: personalAgent.user_id,
      dedicatedAgentId: "dedicated-agent-miniflare",
    });
    const sealedBody = await sealed.text();
    expect(sealed.status, sealedBody).toBe(200);
    expect(JSON.parse(sealedBody)).toEqual({ success: true, history });

    const committed = await post(personalAgent.id, "/cutover-commit", {
      operation: "cutover-commit",
      token,
    });
    expect(committed.status, await committed.text()).toBe(200);

    const reminder = await post(personalAgent.id, "/personal-bridge", {
      operation: "personal-bridge",
      agent: personalAgent,
      rpc: {
        jsonrpc: "2.0",
        id: "telegram:reminder-after-cutover",
        method: "message.send",
        params: {
          text: "Remind me in 2 minutes to stretch",
          roomId: personalAgent.id,
          conversationId: personalAgent.id,
          clientMessageId: "telegram:reminder-after-cutover",
          platformName: "telegram",
          source: "telegram",
        },
      },
    });
    const reminderBody = await reminder.text();
    expect(reminder.status, reminderBody).toBe(409);
    expect(JSON.parse(reminderBody)).toEqual({
      success: false,
      error: "This personal Eliza is active on Dedicated.",
      code: "personal_eliza_dedicated",
      retryable: false,
    });

    const after = await post(personalAgent.id, "/history", {
      operation: "history",
      agentId: personalAgent.id,
      roomId: personalAgent.id,
    });
    const afterBody = await after.text();
    expect(after.status, afterBody).toBe(200);
    expect(JSON.parse(afterBody)).toEqual({ history });
    expect(modelRequests).toEqual([]);

    // Dedicated access withdrawn (#25146): the scoped fallback journal is a
    // separate coordinator that admits the platform-funded turn with the
    // server-owned account state while the canonical room stays sealed, and
    // it loads none of the canonical (pre-upgrade/Dedicated) history.
    const journalRoomId = "fallback:6d8f0a52-3c1e-4f8b-9a2d-1b7e5c4d3a21";
    const accountState = {
      access: "shared_fallback",
      state: "shared_active",
      reason: "subscription_payment_failed",
      dedicatedMemory: "unavailable",
      generation: 1,
      dedicatedRetainedUntil: "2026-10-27T00:00:00.000Z",
      recoveryAction: { kind: "restore_subscription", path: "/cloud/billing" },
    };
    const fallbackTurn = (state: unknown) =>
      post(`${personalAgent.id}:${journalRoomId}`, "/personal-bridge", {
        operation: "personal-bridge",
        agent: personalAgent,
        trustedAccountState: state,
        rpc: {
          jsonrpc: "2.0",
          id: "fallback-account-state",
          method: "message.send",
          params: {
            text: "What did we work on last week?",
            roomId: journalRoomId,
          },
        },
      });
    const admitted = await fallbackTurn(accountState);
    const admittedBody = await admitted.text();
    expect(admitted.status, admittedBody).toBe(200);
    const echoed = JSON.parse(
      (JSON.parse(admittedBody) as { result: { text: string } }).result.text,
    );
    expect(echoed).toEqual({ accountState, funding: "platform", history: [] });

    // The signed, expiring pay-action link crosses the boundary unchanged on
    // both the buffered and the streaming turn.
    const linked = {
      ...accountState,
      recoveryAction: {
        ...accountState.recoveryAction,
        link: {
          url: "https://cloud.example.test/api/v1/eliza/personal/recovery/eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ1In0.c2ln",
          expiresAt: "2026-09-30T00:00:00.000Z",
        },
      },
    };
    const linkedTurn = await fallbackTurn(linked);
    const linkedBody = await linkedTurn.text();
    expect(linkedTurn.status, linkedBody).toBe(200);
    expect(
      JSON.parse(
        (JSON.parse(linkedBody) as { result: { text: string } }).result.text,
      ).accountState,
    ).toEqual(linked);
    const streamed = await post(
      `${personalAgent.id}:${journalRoomId}`,
      "/personal-stream",
      {
        operation: "personal-stream",
        agent: personalAgent,
        trustedAccountState: linked,
        rpc: {
          jsonrpc: "2.0",
          id: "fallback-account-state-stream",
          method: "message.send",
          params: { text: "Where is my Dedicated?", roomId: journalRoomId },
        },
      },
    );
    const streamedBody = await streamed.text();
    expect(streamed.status, streamedBody).toBe(200);
    expect(streamedBody).toContain(
      JSON.stringify({ accountState: linked, funding: "platform" }),
    );

    // Anything but the exact minimal shape is rejected at the boundary.
    for (const invalid of [
      { ...accountState, cardLast4: "4242" },
      { ...accountState, dedicatedMemory: "available" },
      {
        ...accountState,
        recoveryAction: {
          kind: "restore_subscription",
          path: "https://x.test",
        },
      },
      {
        ...linked,
        recoveryAction: {
          ...linked.recoveryAction,
          link: {
            ...linked.recoveryAction.link,
            url: `${linked.recoveryAction.link.url}?card=4242424242424242`,
          },
        },
      },
      {
        ...linked,
        recoveryAction: {
          ...linked.recoveryAction,
          link: { ...linked.recoveryAction.link, cardLast4: "4242" },
        },
      },
    ]) {
      const rejected = await fallbackTurn(invalid);
      const rejectedBody = await rejected.text();
      expect(rejected.status, rejectedBody).toBe(400);
      expect(JSON.parse(rejectedBody)).toMatchObject({
        code: "invalid_account_state",
      });
    }
    expect(modelRequests).toEqual([]);
  }, 120_000);

  test("fallback recovery seals its imported snapshot and retains admission fencing after failed import", async () => {
    if (
      process.env.DATABASE_URL &&
      !process.env.DATABASE_URL.startsWith("pglite")
    ) {
      throw new Error("Fallback recovery fixture requires isolated PGlite");
    }
    process.env.DATABASE_URL = "pglite://memory";
    const { elizaSandboxService } = await import(
      "../../shared/src/lib/services/eliza-sandbox"
    );
    const { reconcilePersonalFallbackIntoDedicated } = await import(
      "../../shared/src/lib/services/personal-dedicated-fallback-reconcile"
    );
    const agent = {
      id: "personal:fallback-recovery-workerd",
      organization_id: "fallback-organization",
      user_id: "fallback-user",
      character_id: null,
      agent_name: "Eliza",
      agent_config: { character: { name: "Eliza" } },
      execution_tier: "shared",
    };
    const roomId = "fallback:recovery-workerd";
    const room = `${agent.id}:${roomId}`;
    const history = [
      {
        id: "fallback-user-message",
        role: "user",
        content: "Retain this complete turn",
        createdAt: 1787184000000,
      },
    ];
    const seeded = await post(room, "/__test/seed", {
      conversation: {
        agentId: agent.id,
        channelId: roomId,
        history,
        dirty: false,
        version: 1,
      },
    });
    expect(seeded.status, await seeded.text()).toBe(200);
    const namespace = {
      getByName(name: string) {
        return {
          fetch: async (url: string | Request, init?: RequestInit) => {
            const request = new Request(url, init);
            const response = await post(
              name,
              new URL(request.url).pathname,
              (await request.json()) as Record<string, unknown>,
            );
            return new Response(await response.arrayBuffer(), {
              status: response.status,
              headers: Object.fromEntries(response.headers),
            });
          },
        };
      },
    };
    const fallback = {
      id: "fallback-interval",
      generation: 1,
      revision: 7,
      source_agent_id: agent.id,
      journal_room_id: roomId,
      organization_id: agent.organization_id,
      user_id: agent.user_id,
      dedicated_agent_id: "dedicated-recovery",
      state: "recovery_pending",
    } as Parameters<
      typeof reconcilePersonalFallbackIntoDedicated
    >[0]["fallback"];
    let releaseImport = () => {};
    let startedImport = () => {};
    const importing = new Promise<void>((resolve) => {
      startedImport = resolve;
    });
    const importGate = new Promise<void>((resolve) => {
      releaseImport = resolve;
    });
    const importer = spyOn(
      elizaSandboxService,
      "importCanonicalConversation",
    ).mockImplementation(async () => {
      startedImport();
      await importGate;
      return null;
    });
    const recovery = reconcilePersonalFallbackIntoDedicated({
      fallback,
      namespace,
    });
    try {
      await importing;
      expect(importer).toHaveBeenCalledWith(
        fallback.dedicated_agent_id,
        agent.organization_id,
        agent.id,
        [
          {
            sourceId: history[0].id,
            role: "user",
            text: history[0].content,
            timestamp: history[0].createdAt,
          },
        ],
      );
      const turn = () =>
        post(room, "/personal-bridge", {
          operation: "personal-bridge",
          agent,
          rpc: {
            jsonrpc: "2.0",
            id: "fallback-account-state",
            method: "message.send",
            params: { text: "arrived after snapshot", roomId },
          },
        });
      const held = await turn();
      expect(held.status, await held.text()).toBe(423);
      releaseImport();
      expect(await recovery).toEqual({
        reconciled: false,
        reason: "import_failed",
      });

      // Renew the same attempt with a short lease. Expiry must consult this
      // interval, not the already-committed original Dedicated upgrade.
      const sealPayload = {
        operation: "cutover-seal",
        agentId: agent.id,
        roomId,
        organizationId: agent.organization_id,
        userId: agent.user_id,
        dedicatedAgentId: fallback.dedicated_agent_id,
        token: `fallback-recovery:${fallback.id}:${fallback.revision}`,
        leaseMs: 1,
        fallback: { id: fallback.id, generation: 1, revision: 7, roomId },
      };
      const resealed = await post(room, "/cutover-seal", sealPayload);
      expect(resealed.status, await resealed.text()).toBe(200);
      await new Promise((resolve) => setTimeout(resolve, 10));
      const readsBefore = fallbackAuthorityReads;
      fallbackResolution = "pending";
      const expired = await turn();
      expect(expired.status, await expired.text()).toBe(423);
      expect(fallbackAuthorityReads).toBeGreaterThan(readsBefore);
      // A late release cannot reopen a snapshot whose import may be in flight.
      const release = await post(room, "/cutover-release", {
        operation: "cutover-release",
        token: `fallback-recovery:${fallback.id}:${fallback.revision}`,
      });
      expect(release.status, await release.text()).toBe(409);
      const stillHeld = await turn();
      expect(stillHeld.status, await stillHeld.text()).toBe(423);
      // Reusing the token cannot renew a seal whose authority conflicts.
      fallbackResolution = "conflict";
      const conflictingRenewal = await post(room, "/cutover-seal", sealPayload);
      expect(conflictingRenewal.status, await conflictingRenewal.text()).toBe(
        423,
      );
      // Only a superseding database revision can invalidate this attempt.
      fallbackResolution = "released";
      const resumed = await turn();
      expect(resumed.status, await resumed.text()).toBe(200);
      // A database commit with a lost DO acknowledgement closes the old
      // journal permanently when its lease expires.
      const finalSeal = await post(room, "/cutover-seal", sealPayload);
      expect(finalSeal.status, await finalSeal.text()).toBe(200);
      await new Promise((resolve) => setTimeout(resolve, 10));
      fallbackResolution = "committed";
      const committed = await turn();
      expect(committed.status, await committed.text()).toBe(409);
    } finally {
      releaseImport();
      await recovery;
      importer.mockRestore();
      fallbackResolution = "pending";
    }
  }, 120_000);

  test("an evicted object reloads a checkpointed interrupted turn before admission", async () => {
    const within = async <T>(
      label: string,
      operation: Promise<T>,
    ): Promise<T> =>
      await Promise.race([
        operation,
        new Promise<never>((_resolve, reject) => {
          setTimeout(() => reject(new Error(`${label} timed out`)), 5_000);
        }),
      ]);
    const agent = {
      id: "agent-barge-eviction-miniflare",
      organization_id: "organization-barge-eviction",
      user_id: "user-barge-eviction",
      character_id: null,
      agent_name: "Eliza",
      agent_config: { character: { name: "Eliza" } },
      execution_tier: "shared",
    };
    const room = "room-barge-eviction-miniflare";
    const seeded = await post(room, "/__test/seed", {
      conversation: {
        agentId: agent.id,
        channelId: room,
        history: [],
        dirty: false,
        version: 1,
      },
    });
    expect(seeded.status, await seeded.text()).toBe(200);

    const barged = await post(room, "/__test/barge", {
      operation: "stream",
      agent,
      rpc: {
        jsonrpc: "2.0",
        id: "barge-eviction",
        method: "message.send",
        params: { text: "interrupted request", roomId: room },
      },
    });
    expect(barged.status, await barged.text()).toBe(200);
    releaseFinalizationGate();

    const admitted = await within(
      "post-failure history",
      post(room, "/history", {
        operation: "history",
        agentId: agent.id,
        roomId: room,
      }),
    );
    const admittedBody = (await admitted.json()) as {
      history: Array<{ id?: string }>;
    };
    expect(admitted.status).toBe(200);
    expect(admittedBody.history.map((message) => message.id)).toEqual([
      "workerd-interrupted-user",
      "workerd-interrupted-assistant",
    ]);

    await within(
      "Durable Object eviction",
      miniflare.unsafeEvictDurableObject("", "TestSharedRuntimeConversation", {
        name: room,
        webSockets: "close",
      }),
    );
    const recovered = await post(room, "/history", {
      operation: "history",
      agentId: agent.id,
      roomId: room,
    });
    const recoveredBody = (await recovered.json()) as {
      history: Array<{ id?: string; interrupted?: boolean }>;
    };
    expect(recoveredBody.history).toMatchObject([
      { id: "workerd-interrupted-user" },
      { id: "workerd-interrupted-assistant", interrupted: true },
    ]);
    releaseFinalizationGate();
  }, 120_000);

  test("a connector turn refused by the cutover seal is a retryable hold, before and after commit", async () => {
    const { coordinateSharedBridge } = await import(
      "../../shared/src/lib/services/shared-runtime/conversation-coordinator"
    );
    const { PersonalCutoverHoldError } = await import(
      "../../shared/src/lib/services/shared-runtime/shared-runtime-errors"
    );
    const agent = {
      id: "personal:cutover-connector-hold",
      organization_id: "organization-cutover-hold",
      user_id: "user-cutover-hold",
      character_id: null,
      agent_name: "Eliza",
      agent_config: { character: { name: "Eliza" } },
      execution_tier: "shared",
    };
    const room = agent.id;
    const token = "personal-cutover:hold-source:hold-dedicated";
    // The production coordinator client reaches the same Workerd object the
    // seal was written to; only the namespace addressing is substituted.
    const namespace = {
      getByName: () => ({
        fetch: (input: RequestInfo | URL, init?: RequestInit) =>
          miniflare.dispatchFetch(String(input), {
            method: init?.method,
            body: init?.body as string,
            headers: {
              "content-type": "application/json",
              "x-test-room": room,
            },
          }) as unknown as Promise<Response>,
      }),
    };
    const connectorTurn = () =>
      coordinateSharedBridge(
        agent as never,
        {
          jsonrpc: "2.0",
          id: "blooio:eliza-app:held-turn",
          method: "message.send",
          params: {
            text: "remind me to call mom",
            roomId: room,
            clientMessageId: "blooio:eliza-app:held-turn",
          },
        },
        {
          namespace: namespace as never,
          executionCtx: { waitUntil: () => undefined },
          agentKind: "personal",
        },
      );

    const seeded = await post(room, "/__test/seed", {
      conversation: {
        agentId: agent.id,
        channelId: agent.id,
        history: [],
        dirty: false,
        version: 1,
      },
    });
    expect(seeded.status, await seeded.text()).toBe(200);
    const sealed = await post(room, "/cutover-seal", {
      operation: "cutover-seal",
      agentId: agent.id,
      roomId: room,
      token,
      leaseMs: 60_000,
      organizationId: agent.organization_id,
      userId: agent.user_id,
      dedicatedAgentId: "hold-dedicated",
    });
    expect(sealed.status, await sealed.text()).toBe(200);

    // Sealed, not yet committed: a hold the connector retries shortly.
    const whileSealed = await connectorTurn().then(
      () => null,
      (error: unknown) => error,
    );
    expect(whileSealed).toBeInstanceOf(PersonalCutoverHoldError);
    expect(whileSealed).toMatchObject({
      committed: false,
      retryAfterSeconds: 1,
    });

    const committed = await post(room, "/cutover-commit", {
      operation: "cutover-commit",
      token,
    });
    expect(committed.status, await committed.text()).toBe(200);

    // Committed: still a hold, never a terminal conflict, so the retry
    // re-resolves the attested Dedicated route instead of dropping the turn.
    const afterCommit = await connectorTurn().then(
      () => null,
      (error: unknown) => error,
    );
    expect(afterCommit).toBeInstanceOf(PersonalCutoverHoldError);
    expect(afterCommit).toMatchObject({ committed: true });

    // Neither refusal admitted the turn into Shared history or inference.
    const history = await post(room, "/history", {
      operation: "history",
      agentId: agent.id,
      roomId: room,
    });
    expect(await history.json()).toEqual({ history: [] });
  }, 120_000);

  function networkFixture(
    app: NetworkAppId,
    userId = "network-continuous-user",
  ): {
    agent: import("../../shared/src/lib/services/shared-runtime/shared-runtime-agent").SharedRuntimeAgent;
    context: NetworkSharedTurnContext;
  } {
    const organizationId = "network-continuous-org";
    const agent = {
      id: personalSharedAgentId({ userId, organizationId }),
      organization_id: organizationId,
      user_id: userId,
      character_id: null,
      agent_name: "Eliza",
      agent_config: { character: { name: "Eliza", system: "Fixture" } },
      execution_tier: "shared" as const,
    };
    const binding = {
      cloudUserId: userId,
      organizationId,
      app,
      personId: "network-fixture-person",
      memberId: `${app}-fixture-member`,
    };
    return {
      agent,
      context: {
        membership: { ...binding, scopeId: networkMembershipScopeId(binding) },
        context: {
          app,
          memberId: binding.memberId,
          firstName: "Fixture",
          city: "SF",
          state: "open",
          stateUntil: null,
          facets: [],
          activeItems: null,
        },
      },
    };
  }

  test("real DO rejects forged Network scope before transport or history access", async () => {
    const { agent, context } = networkFixture("slop", "network-forgery-user");
    const room = `${agent.id}:${agent.id}`;
    const before = modelRequests.length;
    for (const forged of [
      {
        ...context,
        membership: { ...context.membership, scopeId: "forged-scope" },
      },
      { ...context, context: { ...context.context, app: "friends" } },
      networkFixture("slop", "other-user").context,
    ]) {
      for (const operation of ["personal-bridge", "personal-stream"]) {
        const response = await post(room, "/network-forged", {
          operation,
          agent,
          trustedNetworkContext: forged,
          rpc: {
            jsonrpc: "2.0",
            id: "network-transport-probe",
            method: "message.send",
            params: { text: "Fixture", roomId: agent.id },
          },
        });
        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({
          code: "invalid_network_scope",
        });
      }
    }
    const history = await post(room, "/history", {
      operation: "history",
      agentId: agent.id,
      roomId: agent.id,
    });
    expect(await history.json()).toEqual({ history: [] });
    expect(modelRequests.length).toBe(before);
  });

  test("Slop and Friends transport metadata keep one canonical Personal conversation", async () => {
    const slop = networkFixture("slop", "network-transport-user");
    const friends = networkFixture("friends", "network-transport-user");
    const room = `${slop.agent.id}:${slop.agent.id}`;
    const history = [
      {
        id: "existing-personal-turn",
        role: "user",
        content: "Existing Personal history",
        createdAt: 1,
      },
      {
        id: "prior-slop-turn",
        role: "user",
        content: "Prior Slop discussion",
        createdAt: 2,
      },
      {
        id: "prior-friends-turn",
        role: "user",
        content: "Prior Friends discussion",
        createdAt: 3,
      },
    ];
    await post(room, "/__test/seed", {
      conversation: {
        agentId: slop.agent.id,
        channelId: slop.agent.id,
        history,
        dirty: false,
        version: 1,
      },
    });
    for (const fixture of [slop, friends]) {
      const response = await post(room, "/network-transport-probe", {
        operation: "personal-bridge",
        agent: fixture.agent,
        trustedNetworkContext: fixture.context,
        rpc: {
          jsonrpc: "2.0",
          id: "network-transport-probe",
          method: "message.send",
          params: {
            text: "Fixture transport only",
            roomId: fixture.agent.id,
            clientMessageId: `transport-${fixture.context.membership.app}`,
          },
        },
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        result: { observation: fixture.context, roomId: slop.agent.id },
      });
    }
    const result = await post(room, "/history", {
      operation: "history",
      agentId: slop.agent.id,
      roomId: slop.agent.id,
    });
    expect(await result.json()).toEqual({ history });
  });

  test("actual Shared bridge and stream replay DO receipts across Network changes without inference", async () => {
    const slop = networkFixture("slop", "network-claim-user");
    const friends = networkFixture("friends", "network-claim-user");
    const room = `${slop.agent.id}:${slop.agent.id}`;
    const channelId = sharedRuntimeRoomKey(slop.agent.id, slop.agent.id);
    const existing = [
      {
        id: "continuous-slop-history",
        role: "user" as const,
        content: "Slop history",
        createdAt: 1,
      },
      {
        id: "continuous-friends-history",
        role: "user" as const,
        content: "Friends history",
        createdAt: 2,
      },
    ];
    await post(room, "/__test/seed", {
      conversation: {
        agentId: slop.agent.id,
        channelId,
        history: existing,
        dirty: false,
        version: 1,
      },
    });
    const priorReceipt: SharedTurnTerminalResult = {
      text: "Seeded prior terminal receipt; no model completion",
      messageId: "receipt-assistant",
      userMessageId: "receipt-user",
      agentName: "Eliza",
      channelId,
      model: "seeded-receipt",
      degraded: false,
      runtime: "shared",
      transport: "shared-runtime",
    };
    let claimCalls = 0;
    let historyLoads = 0;
    let historyMerges = 0;
    const claims: SharedTurnClaimStore = {
      async claim(key, hash) {
        claimCalls++;
        const response = await post(room, "/__test/claims", {
          key,
          hash,
          seedResult: priorReceipt,
        });
        return (await response.json()) as Awaited<
          ReturnType<SharedTurnClaimStore["claim"]>
        >;
      },
      async complete() {
        throw new Error("Replay must not complete a new turn");
      },
    };
    const store: SharedRuntimeHistoryStore = {
      async load(agentId, loadedChannel) {
        historyLoads++;
        const response = await post(room, "/__test/history-store", {
          agentId,
          channelId: loadedChannel,
        });
        return (await response.json()) as typeof existing;
      },
      async merge(agentId, mergedChannel, messages) {
        historyMerges++;
        const response = await post(room, "/__test/history-store", {
          agentId,
          channelId: mergedChannel,
          messages,
        });
        return (await response.json()) as typeof existing;
      },
    };
    const chat = new SharedRuntimeChatService();
    const rpc = {
      jsonrpc: "2.0" as const,
      id: "fixture-retry",
      method: "message.send",
      params: {
        text: "Same complete user message",
        roomId: slop.agent.id,
        clientMessageId: "same-client-key",
      },
    };
    const before = modelRequests.length;
    const unavailable: NetworkSharedTurnObservation = {
      status: "unavailable",
      cloudUserId: slop.agent.user_id,
      organizationId: slop.agent.organization_id,
      reason: "private_service_unavailable",
    };
    // Each first claim seeds a terminal receipt through the production DO
    // ledger. Retry identity belongs to this conversation and submitted text;
    // the server's current Network observation is not new client input.
    for (const [index, firstContext] of [
      slop.context,
      unavailable,
      undefined,
    ].entries()) {
      const submitted = {
        ...rpc,
        params: { ...rpc.params, clientMessageId: `same-client-key-${index}` },
      };
      const options = {
        turnClaims: claims,
        historyStore: store,
        funding: "platform" as const,
      };
      const original = await chat.bridge(slop.agent, submitted, {
        ...options,
        trustedNetworkContext: firstContext,
      });
      expect(original.result).toMatchObject(priorReceipt);
      for (const trustedNetworkContext of [
        slop.context,
        unavailable,
        undefined,
        friends.context,
      ]) {
        const replayOptions = { ...options, trustedNetworkContext };
        const replay = await chat.bridge(slop.agent, submitted, replayOptions);
        expect(replay.result).toMatchObject(priorReceipt);
        const stream = await chat.stream(slop.agent, submitted, replayOptions);
        expect(stream.status).toBe(200);
        const events = (await stream.text()).split("\n\n");
        const done = events.find((event) => event.startsWith("event: done\n"));
        if (!done)
          throw new Error("Replay did not include a terminal SSE frame");
        expect(JSON.parse(done.split("data: ")[1])).toMatchObject({
          messageId: priorReceipt.messageId,
          userMessageId: priorReceipt.userMessageId,
          text: priorReceipt.text,
          fullText: priorReceipt.text,
        });
        const changed = {
          ...submitted,
          params: { ...submitted.params, text: "Changed user message" },
        };
        await expect(
          chat.bridge(slop.agent, changed, replayOptions),
        ).rejects.toMatchObject({
          name: "SharedTurnConflictError",
        });
        await expect(
          chat.stream(slop.agent, changed, replayOptions),
        ).rejects.toMatchObject({
          name: "SharedTurnConflictError",
        });
      }
    }
    const beforeInvalidScope = claimCalls;
    await expect(
      chat.bridge(
        slop.agent,
        { ...rpc, params: { ...rpc.params, roomId: "forged-room" } },
        {
          trustedNetworkContext: slop.context,
          turnClaims: claims,
          historyStore: store,
        },
      ),
    ).rejects.toMatchObject({ code: "NETWORK_SHARED_CONTEXT_SCOPE_INVALID" });
    expect(claimCalls).toBe(beforeInvalidScope);
    expect(historyLoads).toBe(0);
    expect(historyMerges).toBe(0);
    expect(await chat.getHistory(slop.agent.id, slop.agent.id, store)).toEqual(
      existing,
    );
    expect(modelRequests.length).toBe(before);
  });
});
