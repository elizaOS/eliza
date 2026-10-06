/**
 * Runs the production Shared conversation coordinator (Durable Object) in
 * Workerd and proves The Network's project-scoped identity: the same account's
 * Eliza and Network `personal:` ids address different Durable Objects with
 * separate histories, and a delivered Network proactive send lands in the
 * Network history as an assistant turn while Eliza rooms refuse it.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Miniflare } from "miniflare";
import { personalSharedAgentId } from "../../shared/src/lib/services/shared-runtime/personal-shared-identity";

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
  sharedRuntimeErrors:
    /packages[\\/]cloud[\\/]shared[\\/]src[\\/]lib[\\/]services[\\/]shared-runtime[\\/]shared-runtime-errors\.ts$/,
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
      async recordLifecycleEvent(agentId, roomId, event, store) {
        await store.merge(agentId, roomId, [event]);
      },
      async bridge(agent, rpc, options) {
        const text = rpc.params.text;
        await options.historyStore.merge(agent.id, rpc.params.roomId, [
          { id: rpc.id + ":user", role: "user", content: text, createdAt: rpc.params.at },
          {
            id: rpc.id + ":assistant",
            role: "assistant",
            content: agent.agent_name + " heard: " + text,
            createdAt: rpc.params.at + 1,
          },
        ]);
        return {
          jsonrpc: "2.0",
          id: rpc.id,
          result: { text: agent.agent_name + " heard: " + text, funding: options.funding },
        };
      },
      async stream() {
        throw new Error("Streaming is outside this identity test");
      },
    };
  `,
  sharedRuntimeErrors: "export class SharedRuntimeTurnError extends Error {}",
  tierUpgradeTarget:
    "export async function findActivePersonalDedicatedTarget() { return null; }",
} as const;

describe("Network project-scoped personal identity in Workerd", () => {
  let buildDirectory: string;
  let miniflare: Miniflare;
  const modelRequests: string[] = [];
  let releaseFinalizationGate = () => {};
  const finalizationGate = new Promise<void>((resolve) => {
    releaseFinalizationGate = resolve;
  });

  beforeAll(async () => {
    const apiDirectory = fileURLToPath(new URL("../", import.meta.url));
    buildDirectory = await mkdtemp(
      join(tmpdir(), "shared-network-identity-workerd-"),
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

  const account = {
    organizationId: "6f9619ff-8b86-4011-b42d-00c04fc964ff",
    userId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  };
  const elizaId = personalSharedAgentId(account);
  const networkId = personalSharedAgentId({ ...account, project: "network" });
  const baseAgent = {
    organization_id: account.organizationId,
    user_id: account.userId,
    character_id: null,
    agent_config: null,
    execution_tier: "shared",
  };
  const elizaAgent = { ...baseAgent, id: elizaId, agent_name: "Eliza" };
  const networkAgent = {
    ...baseAgent,
    id: networkId,
    agent_name: "The Network",
    project: "network",
  };
  // conversation-coordinator names a personal DM object `${agentId}:${room}`
  // with the agent id as the room.
  const room = (id: string) => `${id}:${id}`;

  let clock = 1_790_000_000_000;
  async function turn(agent: { id: string }, id: string, text: string) {
    clock += 10;
    const response = await post(room(agent.id), "/personal-bridge", {
      operation: "personal-bridge",
      agent,
      rpc: {
        jsonrpc: "2.0",
        id,
        method: "message.send",
        params: { text, roomId: agent.id, clientMessageId: id, at: clock },
      },
    });
    const body = await response.text();
    expect(response.status, body).toBe(200);
    return JSON.parse(body) as { result: { text: string; funding: string } };
  }

  async function history(agentId: string) {
    const response = await post(room(agentId), "/history", {
      operation: "history",
      agentId,
      roomId: agentId,
    });
    const body = await response.text();
    expect(response.status, body).toBe(200);
    return (
      JSON.parse(body) as {
        history: Array<{ id: string; role: string; content: string }>;
      }
    ).history;
  }

  test("one account's Eliza and Network chats use separate Durable Objects and histories", async () => {
    expect(networkId).not.toBe(elizaId);
    expect(networkId.startsWith("personal:")).toBe(true);

    const eliza = await turn(
      elizaAgent,
      "twilio:eliza-app:SM1",
      "remind me to call mom",
    );
    const network = await turn(
      networkAgent,
      "twilio:network:SM2",
      "pause my intros",
    );
    // Both keep the personal: prefix contract: platform-funded personal turns.
    expect(eliza.result).toEqual({
      text: "Eliza heard: remind me to call mom",
      funding: "platform",
    });
    expect(network.result).toEqual({
      text: "The Network heard: pause my intros",
      funding: "platform",
    });

    expect((await history(elizaId)).map((message) => message.content)).toEqual([
      "remind me to call mom",
      "Eliza heard: remind me to call mom",
    ]);
    expect(
      (await history(networkId)).map((message) => message.content),
    ).toEqual(["pause my intros", "The Network heard: pause my intros"]);
    expect(modelRequests).toEqual([]);
  }, 120_000);

  test("a delivered Network proactive send is an assistant turn in the Network history only", async () => {
    const elizaBefore = await history(elizaId);
    const event = {
      id: "network-proactive:network:intro:opp-1:1",
      content: "Ada is free Thursday at 6. Want me to set up a coffee intro?",
      createdAt: clock + 5,
    };
    const append = async (
      agentId: string,
      project: string,
      userId = account.userId,
    ) =>
      await post(room(agentId), "/project-proactive-turn", {
        operation: "project-proactive-turn",
        agentId,
        roomId: agentId,
        project,
        userId,
        organizationId: account.organizationId,
        event,
      });

    const appended = await append(networkId, "network");
    expect(appended.status, await appended.text()).toBe(200);
    // A replay of the same delivery merges onto the same turn.
    const replayed = await append(networkId, "network");
    expect(replayed.status, await replayed.text()).toBe(200);

    const networkHistory = await history(networkId);
    expect(networkHistory.at(-1)).toMatchObject({
      id: event.id,
      role: "assistant",
      content: event.content,
    });
    expect(
      networkHistory.filter((message) => message.id === event.id),
    ).toHaveLength(1);

    // The member's reply now has the proactive message as context.
    await turn(networkAgent, "twilio:network:SM3", "yes please");
    expect(
      (await history(networkId)).slice(-3).map((message) => message.role),
    ).toEqual(["assistant", "user", "assistant"]);

    // Eliza rooms (and forged Network ids) refuse proactive assistant turns.
    for (const refused of [
      await append(elizaId, "network"),
      await append(elizaId, "eliza-app"),
      await append(networkId, "eliza-app"),
      await append(
        networkId,
        "network",
        "00000000-0000-4000-8000-000000000001",
      ),
    ]) {
      expect(refused.status).toBe(400);
      expect(await refused.json()).toEqual({
        success: false,
        code: "invalid_project_proactive_turn",
      });
    }
    expect(await history(elizaId)).toEqual(elizaBefore);
  }, 120_000);
});
