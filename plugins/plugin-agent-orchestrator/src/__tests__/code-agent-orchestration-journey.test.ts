/**
 * Code-agent orchestration journey through the production TASKS action and ACP
 * service. The coding agent itself is deterministic, but it speaks native ACP
 * over stdio and asks the orchestrator to execute real workspace file writes.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
  UUID,
} from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tasksAction } from "../actions/tasks.js";
import { AcpService } from "../services/acp-service.js";

const FAKE_AGENT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "__tests__",
  "fixtures",
  "fake-acp-agent.mjs",
);

const AGENT_ID = "00000000-0000-4000-8000-00000000c0de" as UUID;
const ROOM_ID = "11111111-1111-4111-8111-111111111111" as UUID;
const USER_ID = "22222222-2222-4222-8222-222222222222" as UUID;
const WORLD_ID = "33333333-3333-4333-8333-333333333333" as UUID;

function makeRuntime(
  getAcpService: () => AcpService | undefined,
): IAgentRuntime {
  return {
    agentId: AGENT_ID,
    character: { name: "Journey Tester" },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    getSetting: (key: string) => {
      if (key === "ELIZA_ACP_TRANSPORT") return "native";
      if (key === "ELIZA_ACP_DEFAULT_AGENT") return "elizaos";
      if (key === "ELIZA_ACP_NO_TERMINAL") return "true";
      if (key === "ELIZA_ELIZAOS_ACP_COMMAND") return `node ${FAKE_AGENT}`;
      return process.env[key as keyof typeof process.env] as string | undefined;
    },
    getService: (type: string) => {
      const service = getAcpService();
      return type === "ACP_SERVICE" || type === "ACP_SUBPROCESS_SERVICE"
        ? service
        : undefined;
    },
    hasService: (type: string) => type === "ACP_SUBPROCESS_SERVICE",
    getServiceLoadPromise: async (type: string) => {
      const service = getAcpService();
      if (type === "ACP_SUBPROCESS_SERVICE") return service;
      return undefined;
    },
    getRoom: vi.fn(async () => ({
      id: ROOM_ID,
      type: "group",
      name: "coding task",
    })),
    createRoom: vi.fn(async () => ROOM_ID),
    createEntity: vi.fn(async () => true),
    addParticipant: vi.fn(async () => true),
    getEntitiesForRoom: vi.fn(async () => []),
    reportError: vi.fn(),
    emitEvent: vi.fn(async () => undefined),
  } as unknown as IAgentRuntime;
}

function makeMessage(workdir: string): Memory {
  return {
    id: "44444444-4444-4444-8444-444444444444" as UUID,
    entityId: USER_ID,
    roomId: ROOM_ID,
    worldId: WORLD_ID,
    agentId: AGENT_ID,
    content: {
      text: "Spawn a coding agent to build a random-color app.",
      source: "test",
      action: "spawn_agent",
      task: "Build a random-color web app with a button and a test",
      workdir,
      requestedBackend: "elizaos",
      approvalPreset: "permissive",
    },
    createdAt: Date.now(),
  } as Memory;
}

describe("code-agent orchestration journey", () => {
  let workdir: string;
  let service: AcpService | undefined;
  let sessionId: string | undefined;

  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), "code-agent-orchestration-"));
  });

  afterEach(async () => {
    if (sessionId) await service?.closeSession(sessionId).catch(() => {});
    await service?.stop().catch(() => {});
    rmSync(workdir, { recursive: true, force: true });
    vi.restoreAllMocks();
    sessionId = undefined;
  });

  it("dispatches TASKS_SPAWN_AGENT through ACP and completes with real workspace artifacts", async () => {
    const runtime = makeRuntime(() => service);
    service = new AcpService(runtime);
    const events: string[] = [];
    service.onSessionEvent((id, event) => {
      sessionId = id;
      events.push(event);
    });
    await service.start();

    const callbacks: string[] = [];
    const callback: HandlerCallback = async (response) => {
      callbacks.push(response.text ?? "");
      return [];
    };

    const result = await tasksAction.handler(
      runtime,
      makeMessage(workdir),
      {} as State,
      {
        parameters: {
          action: "spawn_agent",
          task: "Build a random-color web app with a button and a test",
          workdir,
          requestedBackend: "elizaos",
          approvalPreset: "permissive",
        },
      },
      callback,
    );

    if (result?.success !== true) {
      throw new Error(JSON.stringify(result, null, 2));
    }
    expect(result).toMatchObject({
      success: true,
      continueChain: false,
    });
    expect(result?.data).toMatchObject({
      agentType: "elizaos",
      workdir,
      status: "ready",
    });

    await vi.waitFor(
      () => {
        expect(events).toContain("task_complete");
      },
      { timeout: 60_000 },
    );

    expect(existsSync(join(workdir, "index.html"))).toBe(true);
    expect(existsSync(join(workdir, "app.js"))).toBe(true);
    expect(existsSync(join(workdir, "app.test.js"))).toBe(true);
    expect(readFileSync(join(workdir, "app.js"), "utf8")).toContain(
      "randomColor",
    );
    expect(events).toEqual(
      expect.arrayContaining(["plan", "tool_running", "task_complete"]),
    );
    expect(callbacks).toEqual([]);
  }, 90_000);
});
