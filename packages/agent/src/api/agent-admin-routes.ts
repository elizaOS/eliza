/**
 * Mounts the destructive agent-admin HTTP routes on the shared route state:
 * POST /api/agent/restart re-initializes the runtime through the injected restart
 * handler and refreshes the reported status, and POST /api/agent/reset stops the
 * runtime, deletes the PGlite data directory (guarded to only ever remove a path
 * whose basename is `.elizadb`), clears the persisted first-run config, and wipes
 * the cloud vault entries so the next boot does not rehydrate a signed-in Eliza
 * Cloud state. Sits behind the authenticated dashboard gate; not public.
 */
import path from "node:path";
import { createRuntimeAccountStoragePolicy } from "@elizaos/auth/auth";
import {
  type AgentRuntime,
  ElizaError,
  normalizeCharacterLanguage,
  resolveUserPath,
  type UUID,
} from "@elizaos/core";
import {
  getDefaultStylePreset,
  type RouteHelpers,
  type RouteRequestMeta,
} from "@elizaos/host/protocol";
import { loadElizaConfig, saveElizaConfig } from "../config/config.ts";
import { resolveEffectiveDbProvider } from "../runtime/database-selection.ts";
import { getAgentHostBridge } from "../runtime/host-bridge.ts";
import { removeResetCredentialsFromVault } from "../runtime/operations/vault-bridge.ts";
import { detectRuntimeModel } from "./agent-model.ts";
import { clearPersistedFirstRunConfig } from "./provider-switch-config.ts";
import { quiesceRuntimeBeforeReplacement } from "./runtime-replacement-ownership.ts";
import type { RuntimeRestartOptions } from "./server.ts";

type AgentStateStatus =
  | "not_started"
  | "starting"
  | "running"
  | "paused"
  | "stopped"
  | "restarting"
  | "error";

function resolveDefaultAgentName(config: Record<string, unknown>): string {
  const ui = config.ui as
    | { assistant?: { name?: string }; language?: string }
    | undefined;
  const agents = config.agents as
    | { list?: Array<{ name?: string }> }
    | undefined;
  const configuredName =
    ui?.assistant?.name?.trim() ?? agents?.list?.[0]?.name?.trim();
  if (configuredName) {
    return configuredName;
  }

  return getDefaultStylePreset(normalizeCharacterLanguage(ui?.language)).name;
}

export interface AgentAdminRouteState {
  runtime: AgentRuntime | null;
  config: Record<string, unknown>;
  agentState: AgentStateStatus;
  agentName: string;
  model: string | undefined;
  startedAt: number | undefined;
  chatRoomId: UUID | null;
  chatUserId: UUID | null;
  chatConnectionReady: { userId: UUID; roomId: UUID; worldId: UUID } | null;
  chatConnectionPromise: Promise<void> | null;
  runtimeStopPromise: Promise<void> | null;
  pendingRestartReasons: string[];
  conversations?: Map<string, unknown>;
  activeConversationId?: string | null;
  conversationRestorePromise?: Promise<void> | null;
}

export interface AgentAdminRouteContext
  extends RouteRequestMeta,
    Pick<RouteHelpers, "json" | "error"> {
  state: AgentAdminRouteState;
  onRestart?:
    | ((options?: RuntimeRestartOptions) => Promise<AgentRuntime | null>)
    | undefined;
  restartRequiresRuntimeDisposal?: boolean;
  onRuntimeSwapped?: () => void;
  onRuntimeActivated?: (
    previousRuntime: AgentRuntime | null,
    activeRuntime: AgentRuntime,
  ) => void | Promise<void>;
  resolveStateDir: () => string;
  stateDirExists: (resolvedState: string) => boolean;
  removeStateDir: (resolvedState: string) => void;
}

/**
 * The local store that Reset deletes. Reset only erases the default PGlite
 * directory; for any other store it throws before the runtime stops, so the
 * route cannot report a reset that left conversations and memory in place.
 */
export function resolveResetPgliteDataDir(
  config: ReturnType<typeof loadElizaConfig>,
  defaultWorkspaceDir: string,
): string {
  const provider = resolveEffectiveDbProvider(config);
  if (provider !== "pglite") {
    throw new ElizaError(
      `Reset cannot erase the ${provider} database. Erase it with your database tools, or switch to the local database before you reset.`,
      { code: "AGENT_RESET_DATABASE_UNSUPPORTED" },
    );
  }
  const explicitDataDir = process.env.PGLITE_DATA_DIR?.trim();
  const configuredDataDir = config.database?.pglite?.dataDir?.trim();
  const dataDir = resolveUserPath(
    explicitDataDir ||
      configuredDataDir ||
      path.join(
        config.agents?.defaults?.workspace ?? defaultWorkspaceDir,
        ".elizadb",
      ),
  );
  if (path.basename(dataDir) !== ".elizadb") {
    throw new ElizaError(
      `Reset will not delete the custom database directory ${dataDir}. Erase it yourself before you reset.`,
      { code: "AGENT_RESET_DATABASE_UNSUPPORTED" },
    );
  }
  return dataDir;
}

export async function handleAgentAdminRoutes(
  ctx: AgentAdminRouteContext,
): Promise<boolean> {
  const {
    res,
    method,
    pathname,
    state,
    onRestart,
    onRuntimeSwapped,
    onRuntimeActivated,
    json,
    error,
    resolveStateDir,
    stateDirExists,
    removeStateDir,
  } = ctx;

  if (method === "POST" && pathname === "/api/agent/restart") {
    if (state.runtimeStopPromise) {
      error(res, "Agent stop is still in progress", 409);
      return true;
    }
    if (!onRestart) {
      error(
        res,
        "Restart is not supported in this mode (no restart handler registered)",
        501,
      );
      return true;
    }

    if (state.agentState === "restarting") {
      error(res, "A restart is already in progress", 409);
      return true;
    }
    // A start builds its runtime through the same handler. A second build
    // now would activate two runtimes and never dispose the first.
    if (state.agentState === "starting") {
      error(res, "The agent is starting; retry when it is running", 409);
      return true;
    }

    const previousState = state.agentState;
    state.agentState = "restarting";
    try {
      const previousRuntime = state.runtime;
      const newRuntime = ctx.restartRequiresRuntimeDisposal
        ? await onRestart({ disposeCurrentBeforeBuild: true })
        : await onRestart();
      if (newRuntime) {
        await quiesceRuntimeBeforeReplacement(previousRuntime, newRuntime);
        state.runtime = newRuntime;
        state.chatConnectionReady = null;
        state.chatConnectionPromise = null;
        state.agentState = "running";
        state.agentName =
          newRuntime.character.name ?? resolveDefaultAgentName(state.config);
        state.model = detectRuntimeModel(newRuntime);
        state.startedAt = Date.now();
        state.pendingRestartReasons = [];
        onRuntimeSwapped?.();
        await onRuntimeActivated?.(previousRuntime, newRuntime);
        json(res, {
          ok: true,
          pendingRestart: false,
          status: {
            state: state.agentState,
            agentName: state.agentName,
            model: state.model,
            startedAt: state.startedAt,
          },
        });
      } else {
        if (ctx.restartRequiresRuntimeDisposal) state.runtime = null;
        state.agentState = ctx.restartRequiresRuntimeDisposal
          ? "error"
          : previousState;
        error(
          res,
          "Restart handler returned null — runtime failed to re-initialize",
          500,
        );
      }
    } catch (err) {
      // error-policy:J1 expose restart failure without reviving a disposed runtime.
      const message = err instanceof Error ? err.message : String(err);
      if (ctx.restartRequiresRuntimeDisposal) state.runtime = null;
      state.agentState = ctx.restartRequiresRuntimeDisposal
        ? "error"
        : previousState;
      error(res, `Restart failed: ${message}`, 500);
    }
    return true;
  }

  if (method === "POST" && pathname === "/api/agent/reset") {
    if (state.runtimeStopPromise) {
      error(res, "Agent stop is still in progress", 409);
      return true;
    }
    try {
      const stateDir = resolveStateDir();
      const config = loadElizaConfig();
      const dataDir = resolveResetPgliteDataDir(
        config,
        path.join(stateDir, "workspace"),
      );
      if (state.runtime) {
        await state.runtime.stop({ fast: true });
        state.runtime = null;
      }
      if (stateDirExists(dataDir)) {
        removeStateDir(dataDir);
      }

      clearPersistedFirstRunConfig(
        config,
        createRuntimeAccountStoragePolicy(stateDir),
      );
      saveElizaConfig(config);

      // Wipe cloud-related vault entries so the next boot doesn't re-hydrate
      // the user back into a "signed in to Eliza Cloud" state. Without this,
      // /api/agent/reset clears the renderer UI but the vault still holds
      // ELIZAOS_CLOUD_API_KEY → vault-bootstrap rehydrates env on next start
      // → useCloudState reports cloud connected → user sees themselves still
      // logged in even though they just hit "Reset".
      await removeResetCredentialsFromVault(getAgentHostBridge().sharedVault());

      state.agentState = "stopped";
      state.agentName = resolveDefaultAgentName(config);
      state.model = undefined;
      state.startedAt = undefined;
      state.config = config;
      state.chatRoomId = null;
      state.chatUserId = null;
      state.chatConnectionReady = null;
      state.chatConnectionPromise = null;
      state.pendingRestartReasons = [];
      state.conversations?.clear();
      state.activeConversationId = null;
      state.conversationRestorePromise = null;

      json(res, { ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const unsupported =
        err instanceof ElizaError &&
        err.code === "AGENT_RESET_DATABASE_UNSUPPORTED";
      error(res, `Reset failed: ${message}`, unsupported ? 409 : 500);
    }
    return true;
  }

  return false;
}
