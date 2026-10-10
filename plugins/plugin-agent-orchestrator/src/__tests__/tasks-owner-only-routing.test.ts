/**
 * Verifies that TASKS and the authenticated REST task routes keep owner-only
 * coding backends (routing.coding.ownerOnly: the owner's own Claude/Codex
 * subscription logins) for work the OWNER asked for. Roles resolve through
 * core's role utilities against a stubbed world; no live model.
 */
import * as os from "node:os";
import type { IAgentRuntime, Memory } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { createTaskAction, spawnAgentAction } from "../actions/tasks.js";
import { handleOrchestratorRoutes } from "../api/orchestrator-routes.js";
import { AcpService } from "../services/acp-service.js";
import { OrchestratorTaskService } from "../services/orchestrator-task-service.js";
import { OrchestratorTaskStore } from "../services/orchestrator-task-store.js";
import {
  callback,
  serviceMock,
  state,
} from "../test-utils/action-test-utils.js";

const OWNER = "11111111-1111-4111-8111-111111111111";
const ADMIN = "22222222-2222-4222-8222-222222222222";
const ROUTER_ENTITY = "55555555-5555-4555-8555-555555555555";

type Svc = ReturnType<typeof serviceMock>;

function runtimeFor(svc: Svc): IAgentRuntime {
  return {
    agentId: "agent1",
    character: {
      settings: {
        routing: {
          coding: {
            default: "elizaos",
            ownerDefault: "claude",
            allow: ["elizaos", "claude", "codex"],
            ownerOnly: ["claude", "codex"],
          },
        },
      },
    },
    getSetting: vi.fn((key: string) =>
      key === "ELIZA_ADMIN_ENTITY_ID" ? OWNER : undefined,
    ),
    getService: vi.fn((type: string) => {
      if (type === "ACP_SERVICE" || type === "ACP_SUBPROCESS_SERVICE") {
        return svc;
      }
      return type === "ACPX_SUB_AGENT_ROUTER"
        ? { sharedSubAgentEntityId: () => ROUTER_ENTITY }
        : null;
    }),
    hasService: vi.fn(() => true),
    getRoom: vi.fn(async () => ({ id: "room1", worldId: "world1" })),
    getWorld: vi.fn(async () => ({
      id: "world1",
      metadata: {
        ownership: { ownerId: OWNER },
        roles: { [ADMIN]: "ADMIN" },
        roleSources: { [ADMIN]: "manual" },
      },
    })),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    reportError: vi.fn(),
  } as never;
}

function discordMessage(
  entityId: string,
  content: Record<string, unknown>,
): Memory {
  return {
    id: "msg1",
    entityId,
    agentId: "agent1",
    roomId: "room1",
    content: { source: "discord", text: "build it", ...content },
    createdAt: Date.now(),
  } as never;
}

async function spawn(message: Memory) {
  const svc = serviceMock();
  const result = await spawnAgentAction.handler(
    runtimeFor(svc),
    message,
    state,
    { parameters: { action: "spawn_agent" } },
    callback(),
  );
  return { svc, result };
}

describe("owner-only coding backends", () => {
  it("runs an owner request on the owner default and stamps it", async () => {
    const svc = serviceMock();
    await createTaskAction.handler(
      runtimeFor(svc),
      discordMessage(OWNER, {}),
      state,
      {
        parameters: {
          action: "create",
          task: "build a dice roller",
          workdir: os.tmpdir(),
        },
      },
      callback(),
    );
    expect(svc.spawnSession.mock.calls[0]?.[0]).toMatchObject({
      agentType: "claude",
      metadata: expect.objectContaining({ ownerRequested: true }),
    });
  });

  it("refuses a non-owner's owner-only backend before anything spawns", async () => {
    const { svc, result } = await spawn(
      discordMessage(ADMIN, {
        task: "build a dice roller",
        requestedBackend: "claude",
      }),
    );
    expect(result).toMatchObject({ success: false, error: "FORBIDDEN" });
    expect(svc.spawnSession).not.toHaveBeenCalled();
  });

  it("takes owner provenance from the router's relay only", async () => {
    // The conversations API stores a client's `source` and `metadata`
    // verbatim; only the router's shared entity speaks for a session.
    const relay = (entityId: string) =>
      ({
        ...discordMessage(entityId, {}),
        content: {
          source: "sub_agent",
          text: "verification failed; retry",
          task: "build a dice roller",
          requestedBackend: "claude",
          metadata: {
            subAgent: true,
            subAgentSessionId: "prev-session",
            ownerRequested: true,
          },
        },
      }) as Memory;

    const fromRouter = await spawn(relay(ROUTER_ENTITY));
    expect(fromRouter.svc.spawnSession.mock.calls[0]?.[0]).toMatchObject({
      agentType: "claude",
      metadata: expect.objectContaining({ ownerRequested: true }),
    });

    const forged = await spawn(relay(ADMIN));
    expect(forged.result).toMatchObject({ success: false, error: "FORBIDDEN" });
    expect(forged.svc.spawnSession).not.toHaveBeenCalled();
  });

  it("carries the owner stamp from an API-created task through its fork's spawn", async () => {
    const acp = serviceMock();
    let service: OrchestratorTaskService | undefined;
    const runtime = {
      ...runtimeFor(acp),
      useModel: async () => "{}",
      getService: (type: string) =>
        type === OrchestratorTaskService.serviceType
          ? service
          : type === AcpService.serviceType
            ? acp
            : undefined,
    } as unknown as IAgentRuntime;
    service = new OrchestratorTaskService(runtime, {
      store: new OrchestratorTaskStore({ backend: "memory" }),
    });
    const post = async (pathname: string, body: Record<string, unknown>) => {
      let sent = "";
      await handleOrchestratorRoutes(
        { method: "POST", url: pathname, body } as never,
        {
          writeHead: () => undefined,
          end: (data: string) => {
            sent = data;
          },
        } as never,
        pathname,
        { runtime, acpService: null, workspaceService: null },
      );
      return JSON.parse(sent) as { id: string };
    };

    const created = await post("/api/orchestrator/tasks", {
      title: "build a dice roller",
      workdir: os.tmpdir(),
      providerPolicy: { preferredFramework: "claude" },
    });
    const forked = await post(`/api/orchestrator/tasks/${created.id}/fork`, {});
    await service.spawnAgentForTask(forked.id, { task: "continue" });

    expect(acp.spawnSession.mock.calls[0]?.[0]).toMatchObject({
      agentType: "claude",
      metadata: expect.objectContaining({ ownerRequested: true }),
    });
  });
});
