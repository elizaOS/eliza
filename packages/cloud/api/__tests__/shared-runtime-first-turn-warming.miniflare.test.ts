/**
 * Runs the production Shared conversation coordinator in Workerd and proves the
 * first turn on a cold room joins in-flight history hydration for a bounded
 * time instead of failing with the retryable warming 503 (#22552), that slower
 * hydration still fails closed, and that deferred prewarm bodies observe the
 * room's shared warmup without holding its request queue. A canonical Personal
 * Shared turn records the verified owner for the keep-warm rate-limit gate.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { personalSharedAgentId } from "@elizaos/cloud-shared/lib/services/shared-runtime/personal-shared-identity";
import { Miniflare } from "miniflare";

const RUNTIME_BOUNDARIES = {
  ownerCapture: /shared-owner-model-capture\.ts$/,
  ownerCaptureStore: /shared-owner-model-capture-store\.ts$/,
  personalFallback: /personal-dedicated-fallback\.ts$/,
  apiErrors:
    /packages[\\/]cloud[\\/]shared[\\/]src[\\/]lib[\\/]api[\\/]errors\.ts$/,
  apnsProvider:
    /packages[\\/]cloud[\\/]shared[\\/]src[\\/]lib[\\/]mobile-push[\\/]apns-provider\.ts$/,
  cloudBindings:
    /packages[\\/]cloud[\\/]shared[\\/]src[\\/]lib[\\/]runtime[\\/]cloud-bindings\.ts$/,
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
  // This suite has no capture policy or Dedicated cutover. Keep those service
  // boundaries fail-closed instead of bundling their KMS/SSH dependencies.
  ownerCapture: `
    export function observeOwnerCapture(capture) {
      if (capture !== undefined) throw new Error("Capture is outside this warming test");
    }
  `,
  ownerCaptureStore: `
    export function parseOwnerCapturePolicy(value) {
      if (value !== undefined) throw new Error("Capture policy is outside this warming test");
      return undefined;
    }
    function outside() { throw new Error("Capture storage is outside this warming test"); }
    export { outside as cleanupDueOwnerCaptures, outside as listOwnerCaptureReservations,
      outside as readEncryptedOwnerCapture, outside as reserveOwnerModelCapture };
  `,
  personalFallback: `
    export async function resolvePersonalFallbackCutoverRecovery() {
      throw new Error("Dedicated recovery is outside this warming test");
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
  cloudBindings: `
    export async function runWithCloudBindingsAsync(_bindings, operation) {
      return await operation();
    }
  `,
  coreEdge: `
    export { validateUuid } from ${JSON.stringify(
      fileURLToPath(
        new URL("../../../core/src/utils/uuid.ts", import.meta.url),
      ),
    )};
    export { MediaFetchError, readResponseWithLimit } from ${JSON.stringify(
      fileURLToPath(
        new URL("../../../core/src/media/fetch.ts", import.meta.url),
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
      async get(agentId, channelId) {
        const response = await fetch(
          "https://history-gate.test/" + encodeURIComponent(agentId),
        );
        return await response.json();
      },
      async merge() {},
      async deleteByAgent() {},
    };
  `,
  logger: `
    export const logger = {
      debug() {}, info() {}, warn() {}, error() {},
    };
  `,
  sharedElizaRuntime: `
    export async function prewarmSharedElizaRuntime() {}
    export async function prewarmSharedElizaStreamingContext() {
      const response = await fetch("https://prewarm-gate.test/");
      if (!response.ok) throw new Error("Runtime module warmup failed");
    }
  `,
  sharedRuntimeChat: `
    export const sharedRuntimeChatService = {
      async getHistory(agentId, roomId, store) {
        return await store.load(agentId, roomId);
      },
      async stream() {
        return new Response("event: done\\ndata: {}\\n\\n", {
          headers: { "content-type": "text/event-stream" },
        });
      },
      async bridge() {
        throw new Error("bridge is outside this warming test");
      },
      async recordLifecycleEvent() {
        throw new Error("Lifecycle writes are outside this warming test");
      },
    };
  `,
  sharedRuntimeErrors: "export class SharedRuntimeTurnError extends Error {}",
  tierUpgradeTarget:
    "export async function findActivePersonalDedicatedTarget() { return null; }",
} as const;

describe("Shared first-turn warming in Workerd", () => {
  let buildDirectory: string;
  let miniflare: Miniflare;
  const historyReads: string[] = [];
  let moduleWarmups = 0;
  let moduleGate:
    | {
        entered: () => void;
        result: Promise<number>;
        release: (status?: number) => void;
      }
    | undefined;
  let releaseSlowHistory!: () => void;
  const slowHistory = new Promise<void>((resolve) => {
    releaseSlowHistory = resolve;
  });

  function holdModuleWarmup() {
    if (moduleGate) throw new Error("Another module warmup is held");
    const entered = Promise.withResolvers<void>();
    const result = Promise.withResolvers<number>();
    const gate = {
      entered: entered.resolve,
      result: result.promise,
      release(status = 204) {
        if (moduleGate === gate) moduleGate = undefined;
        result.resolve(status);
      },
    };
    moduleGate = gate;
    return { entered: entered.promise, release: gate.release };
  }

  beforeAll(async () => {
    const apiDirectory = fileURLToPath(new URL("../", import.meta.url));
    buildDirectory = await mkdtemp(
      join(tmpdir(), "shared-first-turn-warming-workerd-"),
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
          conditions: ["worker", "browser"],
          external: ["node:*"],
          plugins: [{
            name: "shared-first-turn-warming-runtime-boundaries",
            setup(build) {
              build.onLoad(
                { filter: boundary(${JSON.stringify(RUNTIME_BOUNDARIES.ownerCapture.source)}) },
                () => ({ loader: "ts", contents: ${JSON.stringify(RUNTIME_STUBS.ownerCapture)} }),
              );
              build.onLoad(
                { filter: boundary(${JSON.stringify(RUNTIME_BOUNDARIES.ownerCaptureStore.source)}) },
                () => ({ loader: "ts", contents: ${JSON.stringify(RUNTIME_STUBS.ownerCaptureStore)} }),
              );
              build.onLoad(
                { filter: boundary(${JSON.stringify(RUNTIME_BOUNDARIES.personalFallback.source)}) },
                () => ({ loader: "ts", contents: ${JSON.stringify(RUNTIME_STUBS.personalFallback)} }),
              );
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
                { filter: boundary(${JSON.stringify(RUNTIME_BOUNDARIES.cloudBindings.source)}) },
                () => ({ loader: "ts", contents: ${JSON.stringify(RUNTIME_STUBS.cloudBindings)} }),
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
        if (!output) throw new Error("Shared warming test Worker was not emitted");
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
        `Failed to bundle Shared warming test Worker:\n${bundleStderr}${bundleStdout}`,
      );
    }
    miniflare = new Miniflare({
      compatibilityDate: "2026-06-01",
      compatibilityFlags: ["nodejs_compat"],
      modules: true,
      script: await readFile(outputPath, "utf8"),
      outboundService: async (request: Request) => {
        const url = new URL(request.url);
        if (url.hostname === "prewarm-gate.test") {
          moduleWarmups++;
          const gate = moduleGate;
          gate?.entered();
          return new Response(null, { status: gate ? await gate.result : 204 });
        }
        if (url.hostname !== "history-gate.test") {
          return Response.json({ error: "unexpected egress" }, { status: 500 });
        }
        const agentId = decodeURIComponent(url.pathname.slice(1));
        const first = !historyReads.includes(agentId);
        historyReads.push(agentId);
        if (agentId.includes("failed-once") && first)
          return new Response("History dependency failed", { status: 503 });
        if (agentId.includes("slow")) await slowHistory;
        else await new Promise((resolve) => setTimeout(resolve, 200));
        return Response.json([
          {
            id: `${agentId}-prior-user`,
            role: "user",
            content: "earlier question",
            createdAt: 1787184000000,
          },
          {
            id: `${agentId}-prior-assistant`,
            role: "assistant",
            content: "earlier answer",
            createdAt: 1787184000001,
          },
        ]);
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
    releaseSlowHistory();
    moduleGate?.release();
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

  function prewarm(agentId: string) {
    return post(`${agentId}:${agentId}`, "/prewarm", {
      operation: "prewarm",
      agentId,
      roomId: agentId,
    });
  }

  async function openPrewarmBody(agentId: string) {
    const response = await prewarm(agentId);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.has("X-Eliza-Release-Coordinator-Queue")).toBe(
      false,
    );
    if (!response.body) throw new Error("Missing prewarm response body");
    return response.body.getReader();
  }

  function observePrewarmRead(
    reader: Awaited<ReturnType<typeof openPrewarmBody>>,
  ) {
    let pending = true;
    const result = (async () => {
      const decoder = new TextDecoder();
      let body = "";
      for (
        let chunk = await reader.read();
        !chunk.done;
        chunk = await reader.read()
      )
        body += decoder.decode(chunk.value, { stream: true });
      return body + decoder.decode();
    })().finally(() => {
      pending = false;
    });
    // Keep an early failure observable through result while checking the room.
    void result.catch(() => {});
    return {
      result,
      get pending() {
        return pending;
      },
    };
  }

  test("a cold room's first history read joins in-flight hydration instead of returning warming", async () => {
    const agentId = "agent-first-turn-warming";
    const response = await post(`${agentId}:${agentId}`, "/history", {
      operation: "history",
      agentId,
      roomId: agentId,
    });
    const body = await response.text();
    expect(response.status, body).toBe(200);
    expect(JSON.parse(body).history).toHaveLength(2);
    expect(body).toContain(`${agentId}-prior-user`);
    expect(body).toContain(`${agentId}-prior-assistant`);
    expect(historyReads.filter((read) => read === agentId)).toHaveLength(1);
  }, 60_000);

  test("hydration slower than the bound still fails closed with the retryable warming", async () => {
    const agentId = "agent-slow-first-turn-warming";
    const room = `${agentId}:${agentId}`;
    const cold = await post(room, "/history", {
      operation: "history",
      agentId,
      roomId: agentId,
    });
    expect(cold.status).toBe(503);
    expect(await cold.text()).toContain("conversation_cache_warming");
    // Release the original read only after the caller has timed out.
    releaseSlowHistory();
    const retried = await post(room, "/history", {
      operation: "history",
      agentId,
      roomId: agentId,
    });
    const body = await retried.text();
    expect(retried.status, body).toBe(200);
    expect(body).toContain(`${agentId}-prior-user`);
    expect(historyReads.filter((read) => read === agentId)).toHaveLength(1);
  }, 60_000);

  test("a failed history load returns warming and starts a fresh read on retry", async () => {
    const agentId = "agent-failed-once-first-turn-warming";
    const room = `${agentId}:${agentId}`;
    const body = { operation: "history", agentId, roomId: agentId };
    const failed = await post(room, "/history", body);
    expect(failed.status).toBe(503);
    expect(await failed.json()).toMatchObject({
      code: "conversation_cache_warming",
      retryable: true,
    });
    expect(historyReads.filter((read) => read === agentId)).toHaveLength(1);

    for (let i = 0; i < 2; i++) {
      const retry = await post(room, "/history", body);
      expect(retry.status).toBe(200);
      expect(await retry.json()).toMatchObject({
        history: [
          { id: `${agentId}-prior-user`, content: "earlier question" },
          { id: `${agentId}-prior-assistant`, content: "earlier answer" },
        ],
      });
    }
    expect(historyReads.filter((read) => read === agentId)).toHaveLength(2);
  }, 60_000);

  test("deferred prewarm joins one warmup and a cancelled body leaves the room and peer live", async () => {
    const agentId = "agent-deferred-prewarm";
    const before = moduleWarmups;
    const gate = holdModuleWarmup();
    try {
      const first = await openPrewarmBody(agentId);
      await gate.entered;
      const second = await openPrewarmBody(agentId);
      const firstRead = observePrewarmRead(first);
      const secondRead = observePrewarmRead(second);

      const history = await post(`${agentId}:${agentId}`, "/history", {
        operation: "history",
        agentId,
        roomId: agentId,
      });
      expect(history.status).toBe(200);
      expect(await history.json()).toMatchObject({
        history: [
          { id: `${agentId}-prior-user`, content: "earlier question" },
          { id: `${agentId}-prior-assistant`, content: "earlier answer" },
        ],
      });
      expect(firstRead.pending).toBe(true);
      expect(secondRead.pending).toBe(true);
      expect(moduleWarmups).toBe(before + 1);
      expect(historyReads.filter((read) => read === agentId)).toHaveLength(1);

      await first.cancel("caller left");
      const canceled = await firstRead.result;
      expect(() => JSON.parse(canceled)).toThrow();
      expect(secondRead.pending).toBe(true);
      expect(moduleWarmups).toBe(before + 1);

      gate.release();
      expect(JSON.parse(await secondRead.result)).toEqual({ success: true });
      expect(moduleWarmups).toBe(before + 1);
    } finally {
      gate.release();
    }
  }, 60_000);

  test("a deferred module failure fails both bodies and a later prewarm starts a fresh attempt", async () => {
    const agentId = "agent-prewarm-module-failure";
    const before = moduleWarmups;
    const failed = holdModuleWarmup();
    try {
      const first = await openPrewarmBody(agentId);
      await failed.entered;
      const second = await openPrewarmBody(agentId);
      const firstRead = observePrewarmRead(first);
      const secondRead = observePrewarmRead(second);
      expect(moduleWarmups).toBe(before + 1);
      failed.release(503);
      const outcomes = await Promise.allSettled([
        firstRead.result,
        secondRead.result,
      ]);
      expect(outcomes.map(({ status }) => status)).toEqual([
        "rejected",
        "rejected",
      ]);
    } finally {
      failed.release();
    }

    const retried = holdModuleWarmup();
    try {
      const response = await openPrewarmBody(agentId);
      await retried.entered;
      const retryRead = observePrewarmRead(response);
      expect(moduleWarmups).toBe(before + 2);
      expect(historyReads.filter((read) => read === agentId)).toHaveLength(1);
      retried.release();
      expect(JSON.parse(await retryRead.result)).toEqual({ success: true });
      const warm = await prewarm(agentId);
      expect(warm.status).toBe(200);
      expect(await warm.json()).toEqual({ success: true });
      expect(moduleWarmups).toBe(before + 2);
    } finally {
      retried.release();
    }
  }, 60_000);

  test("a canonical Personal Shared turn lets keep-warm prewarm report its owning organization", async () => {
    const organizationId = "5e7d1d53-4a55-4d6c-9e0c-1f0a2b3c4d5e";
    const userId = "6f8e2e64-5b66-4e7d-8f1d-2a1b3c4d5e6f";
    const agentId = personalSharedAgentId({ organizationId, userId });
    const room = `${agentId}:${agentId}`;
    const prewarm = {
      operation: "prewarm",
      agentId,
      roomId: agentId,
      startEmpty: true,
    };

    const before = await post(room, "/prewarm", prewarm);
    expect(before.status).toBe(200);
    expect(await before.json()).toEqual({ success: true });

    const streamed = await post(room, "/stream", {
      operation: "personal-stream",
      agent: {
        id: agentId,
        organization_id: organizationId,
        user_id: userId,
        character_id: null,
        agent_name: "Eliza",
        agent_config: { character: { name: "Eliza" } },
        execution_tier: "shared",
      },
      rpc: {
        jsonrpc: "2.0",
        id: "owner-probe",
        method: "message.send",
        params: { text: "hello", roomId: agentId },
      },
    });
    expect(streamed.status, await streamed.text()).toBe(200);

    // A later forged projection whose id is not derived from its account
    // cannot replace the verified owner.
    const forged = await post(room, "/stream", {
      operation: "personal-stream",
      agent: {
        id: agentId,
        organization_id: "7a9f3f75-6c77-4f8e-9a2e-3b2c4d5e6f70",
        user_id: userId,
        character_id: null,
        agent_name: "Eliza",
        agent_config: { character: { name: "Eliza" } },
        execution_tier: "shared",
      },
      rpc: {
        jsonrpc: "2.0",
        id: "forged-owner",
        method: "message.send",
        params: { text: "hello", roomId: agentId },
      },
    });
    await forged.text();

    const after = await post(room, "/prewarm", prewarm);
    expect(after.status).toBe(200);
    expect(await after.json()).toEqual({ success: true, organizationId });
    // Personal rooms start empty: prewarm never reads mirrored history.
    expect(historyReads).not.toContain(agentId);
  }, 60_000);
});
