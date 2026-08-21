/**
 * Runs the production Shared conversation coordinator in Workerd and proves a
 * committed Personal Shared -> Dedicated cutover cannot reopen Shared for a
 * reminder turn.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Miniflare } from "miniflare";

const RUNTIME_BOUNDARIES = {
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
  cachedAgentDates:
    /packages[\\/]cloud[\\/]shared[\\/]src[\\/]lib[\\/]services[\\/]shared-runtime[\\/]cached-agent-dates\.ts$/,
  tierUpgradeTarget:
    /packages[\\/]cloud[\\/]shared[\\/]src[\\/]lib[\\/]services[\\/]agent-tier-upgrade-target\.ts$/,
} as const;

const RUNTIME_STUBS = {
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
      async bridge() {
        await fetch("https://model-probe.test/v1/chat/completions", {
          method: "POST",
          body: "unexpected-shared-reminder-inference",
        });
        throw new Error("Committed cutover reached Shared inference");
      },
      async stream() {
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
  tierUpgradeTarget:
    "export async function findActivePersonalDedicatedTarget() { return null; }",
} as const;

describe("Personal Shared cutover reminder containment in Workerd", () => {
  let buildDirectory: string;
  let miniflare: Miniflare;
  const modelRequests: string[] = [];

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
            if (new URL(request.url).pathname === "/__test/seed") {
              const body = await request.json();
              await this.testState.storage.put("conversation", body.conversation);
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
            return await env.SHARED_RUNTIME_CONVERSATIONS.get(id).fetch(request);
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
            name: "shared-cutover-reminder-runtime-boundaries",
            setup(build) {
              build.onResolve({ filter: /^@elizaos\\/core\\/edge$/ }, () => ({
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
  }, 120_000);
});
