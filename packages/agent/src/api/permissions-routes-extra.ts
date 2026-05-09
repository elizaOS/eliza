import type http from "node:http";
import { logger } from "@elizaos/core";
import type { ElizaConfig } from "../config/config.js";
import type { ReadJsonBodyOptions } from "@elizaos/shared";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type AgentAutomationMode = "connectors-only" | "full";

export interface PermissionsExtraRouteContext {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  method: string;
  pathname: string;
  state: {
    config: ElizaConfig;
    agentAutomationMode?: AgentAutomationMode;
  };
  json: (res: http.ServerResponse, data: unknown, status?: number) => void;
  error: (res: http.ServerResponse, message: string, status?: number) => void;
  readJsonBody: <T extends object>(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    options?: ReadJsonBodyOptions,
  ) => Promise<T | null>;
  saveElizaConfig: (config: ElizaConfig) => void;
  resolveTradePermissionMode: (config: ElizaConfig) => string;
  canUseLocalTradeExecution: (
    mode: string,
    isAgent: boolean,
    scope?: unknown,
    options?: { consumeAgentQuota: boolean },
  ) => boolean;
  parseAgentAutomationMode: (value: unknown) => AgentAutomationMode | null;
  persistAgentAutomationMode: (
    state: { config: ElizaConfig; agentAutomationMode?: AgentAutomationMode },
    mode: AgentAutomationMode,
  ) => void;
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function handlePermissionsExtraRoutes(
  ctx: PermissionsExtraRouteContext,
): Promise<boolean> {
  const { res, method, pathname, state, json, error, readJsonBody } = ctx;

  // ── GET /api/permissions/automation-mode ──────────────────────────────
  if (method === "GET" && pathname === "/api/permissions/automation-mode") {
    const mode = state.agentAutomationMode ?? "full";
    json(res, {
      mode,
      options: ["connectors-only", "full"] as AgentAutomationMode[],
    });
    return true;
  }

  // ── PUT /api/permissions/automation-mode ──────────────────────────────
  if (method === "PUT" && pathname === "/api/permissions/automation-mode") {
    const body = await readJsonBody<{ mode?: unknown }>(ctx.req, res);
    if (!body) return true;
    const parsed = ctx.parseAgentAutomationMode(body.mode);
    if (!parsed) {
      error(res, 'Invalid mode. Expected "connectors-only" or "full".', 400);
      return true;
    }

    ctx.persistAgentAutomationMode(state, parsed);
    ctx.saveElizaConfig(state.config);

    json(res, {
      mode: parsed,
      options: ["connectors-only", "full"] as AgentAutomationMode[],
    });
    return true;
  }

  // ── GET /api/permissions/trade-mode ────────────────────────────────────
  if (method === "GET" && pathname === "/api/permissions/trade-mode") {
    const mode = ctx.resolveTradePermissionMode(state.config);
    json(res, {
      tradePermissionMode: mode,
      canUserLocalExecute: ctx.canUseLocalTradeExecution(mode, false),
      canAgentAutoTrade: ctx.canUseLocalTradeExecution(mode, true, undefined, {
        consumeAgentQuota: false,
      }),
    });
    return true;
  }

  // ── PUT /api/permissions/trade-mode ────────────────────────────────────
  if (method === "PUT" && pathname === "/api/permissions/trade-mode") {
    const body = await readJsonBody<{ mode?: string }>(ctx.req, res);
    if (!body) return true;

    const newMode = body.mode;
    if (
      newMode !== "user-sign-only" &&
      newMode !== "manual-local-key" &&
      newMode !== "agent-auto"
    ) {
      error(
        res,
        'mode must be "user-sign-only", "manual-local-key", or "agent-auto"',
        400,
      );
      return true;
    }

    if (!state.config.features) {
      state.config.features = {};
    }
    (state.config.features as Record<string, unknown>).tradePermissionMode =
      newMode;

    try {
      ctx.saveElizaConfig(state.config);
    } catch (err) {
      logger.warn(
        `[api] Trade-mode config save failed: ${err instanceof Error ? err.message : err}`,
      );
    }

    json(res, {
      ok: true,
      tradePermissionMode: newMode,
      canUserLocalExecute: ctx.canUseLocalTradeExecution(newMode, false),
      canAgentAutoTrade: ctx.canUseLocalTradeExecution(
        newMode,
        true,
        undefined,
        { consumeAgentQuota: false },
      ),
    });
    return true;
  }

  return false;
}
