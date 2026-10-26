/**
 * PUT /api/permissions/automation-mode must not leave the process running
 * under a mode it could not persist. A failed config save has to roll the live
 * state back and answer 500, the same rule the trade-mode handler below it
 * follows.
 */
import type http from "node:http";
import type { AgentAutomationMode } from "@elizaos/core";
import type { ElizaConfig } from "@elizaos/host/protocol";
import { describe, expect, it, vi } from "vitest";
import {
  handlePermissionsExtraRoutes,
  type PermissionsExtraRouteContext,
} from "./permissions-routes-extra.ts";

interface RouteState {
  config: ElizaConfig;
  agentAutomationMode?: AgentAutomationMode;
}

/**
 * Mirrors `persistAgentAutomationMode` in server.ts: it mutates the live
 * features object rather than swapping in a new one.
 */
function persistLikeServer(state: RouteState, mode: AgentAutomationMode): void {
  state.agentAutomationMode = mode;
  if (!state.config.features) {
    state.config.features = {};
  }
  const features = state.config.features as Record<string, unknown>;
  const current = features.agentAutomation;
  const currentObject =
    current && typeof current === "object" && !Array.isArray(current)
      ? (current as Record<string, unknown>)
      : {};
  features.agentAutomation = { ...currentObject, enabled: true, mode };
}

interface Captured {
  handled: boolean;
  status?: number;
  body?: Record<string, unknown>;
  message?: string;
  saved?: ElizaConfig;
}

async function putAutomationMode(
  state: RouteState,
  options: { mode?: unknown; saveError?: Error } = {},
): Promise<Captured> {
  const captured: Captured = { handled: false };
  const ctx = {
    req: {} as http.IncomingMessage,
    res: {} as http.ServerResponse,
    method: "PUT",
    pathname: "/api/permissions/automation-mode",
    state,
    json: (_res: http.ServerResponse, data: unknown, status = 200) => {
      captured.status = status;
      captured.body = data as Record<string, unknown>;
    },
    error: (_res: http.ServerResponse, message: string, status = 500) => {
      captured.status = status;
      captured.message = message;
    },
    readJsonBody: async () => ({ mode: options.mode ?? "connectors-only" }),
    saveElizaConfig: vi.fn((config: ElizaConfig) => {
      captured.saved = config;
      if (options.saveError) throw options.saveError;
    }),
    resolveTradePermissionMode: () => "user-sign-only" as const,
    canUseLocalTradeExecution: () => false,
    parseAgentAutomationMode: (value: unknown) =>
      value === "full" || value === "connectors-only"
        ? (value as AgentAutomationMode)
        : null,
    persistAgentAutomationMode: persistLikeServer,
  } as unknown as PermissionsExtraRouteContext;
  captured.handled = await handlePermissionsExtraRoutes(ctx);
  return captured;
}

function configWithAutomation(mode: AgentAutomationMode): ElizaConfig {
  return {
    features: { agentAutomation: { enabled: true, mode } },
  } as unknown as ElizaConfig;
}

describe("PUT /api/permissions/automation-mode", () => {
  it("keeps the previous mode when the config save fails", async () => {
    const state: RouteState = {
      config: configWithAutomation("full"),
      agentAutomationMode: "full",
    };

    const result = await putAutomationMode(state, {
      mode: "connectors-only",
      saveError: new Error(
        "EACCES: permission denied, open '/state/eliza.json'",
      ),
    });

    expect(result.handled).toBe(true);
    expect(result.status).toBe(500);
    expect(result.message).toContain("Failed to save agent automation mode");
    expect(state.agentAutomationMode).toBe("full");
    expect(state.config.features?.agentAutomation).toEqual({
      enabled: true,
      mode: "full",
    });
  });

  it("removes the block it created when the save fails and none existed", async () => {
    const state: RouteState = { config: {} as ElizaConfig };

    const result = await putAutomationMode(state, {
      mode: "connectors-only",
      saveError: new Error("EROFS: read-only file system"),
    });

    expect(result.status).toBe(500);
    expect(state.agentAutomationMode).toBeUndefined();
    expect(state.config.features).toBeUndefined();
  });

  it("persists and reports the new mode when the save succeeds", async () => {
    const state: RouteState = {
      config: configWithAutomation("full"),
      agentAutomationMode: "full",
    };

    const result = await putAutomationMode(state, { mode: "connectors-only" });

    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      mode: "connectors-only",
      options: ["connectors-only", "full"],
    });
    expect(result.saved).toBe(state.config);
    expect(state.agentAutomationMode).toBe("connectors-only");
    expect(state.config.features?.agentAutomation).toEqual({
      enabled: true,
      mode: "connectors-only",
    });
  });
});
