import path from "node:path";
import type { AgentRuntime, RouteRequestMeta, UUID } from "@elizaos/core";
import type { RouteHelpers } from "@elizaos/shared";
import {
  getDefaultStylePreset,
  normalizeCharacterLanguage,
} from "@elizaos/shared";
import { loadElizaConfig, saveElizaConfig } from "../config/config.js";
import { resolveUserPath } from "../config/paths.js";
import type { AutonomousConfigLike } from "../types/config-like.js";
import { detectRuntimeModel } from "./agent-model.js";
import { clearPersistedOnboardingConfig } from "./provider-switch-config.js";

type AgentStateStatus =
  | "not_started"
  | "starting"
  | "running"
  | "paused"
  | "stopped"
  | "restarting"
  | "error";

type AppCoreRuntimeModule = {
  sharedVault: () => {
    remove: (key: string) => Promise<void> | void;
  };
};

async function importAppCoreRuntime(): Promise<AppCoreRuntimeModule> {
  // String-literal dynamic import — see comment in
  // ../runtime/eliza.ts#importAppCoreRuntime for the AOSP bundle issue
  // that requires Bun.build to statically follow this specifier.
  return import(
    /* webpackIgnore: true */ "@elizaos/app-core"
  ) as Promise<AppCoreRuntimeModule>;
}

function resolveDefaultAgentName(config: AutonomousConfigLike): string {
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
  config: AutonomousConfigLike;
  agentState: AgentStateStatus;
  agentName: string;
  model: string | undefined;
  startedAt: number | undefined;
  chatRoomId: UUID | null;
  chatUserId: UUID | null;
  chatConnectionReady: { userId: UUID; roomId: UUID; worldId: UUID } | null;
  chatConnectionPromise: Promise<void> | null;
  pendingRestartReasons: string[];
  conversations?: Map<string, unknown>;
  activeConversationId?: string | null;
  conversationRestorePromise?: Promise<void> | null;
}

export interface AgentAdminRouteContext
  extends RouteRequestMeta,
    Pick<RouteHelpers, "json" | "error"> {
  state: AgentAdminRouteState;
  onRestart?: (() => Promise<AgentRuntime | null>) | undefined;
  onRuntimeSwapped?: () => void;
  resolveStateDir: () => string;
  resolvePath: (value: string) => string;
  getHomeDir: () => string;
  isSafeResetStateDir: (resolvedState: string, homeDir: string) => boolean;
  stateDirExists: (resolvedState: string) => boolean;
  removeStateDir: (resolvedState: string) => void;
  logWarn: (message: string) => void;
}

function resolveResetPgliteDataDir(
  config: ReturnType<typeof loadElizaConfig>,
  stateDir: string,
): string {
  const explicitDataDir = process.env.PGLITE_DATA_DIR?.trim();
  if (explicitDataDir) {
    return resolveUserPath(explicitDataDir);
  }

  const configuredDataDir = config.database?.pglite?.dataDir?.trim();
  if (configuredDataDir) {
    return resolveUserPath(configuredDataDir);
  }

  const workspaceDir =
    config.agents?.defaults?.workspace ?? `${stateDir}/workspace`;
  return path.join(resolveUserPath(workspaceDir), ".eliza", ".elizadb");
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
    json,
    error,
    resolveStateDir,
    resolvePath,
    getHomeDir,
    isSafeResetStateDir,
    stateDirExists,
    removeStateDir,
    logWarn,
  } = ctx;

  if (method === "POST" && pathname === "/api/agent/restart") {
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

    const previousState = state.agentState;
    state.agentState = "restarting";
    try {
      const newRuntime = await onRestart();
      if (newRuntime) {
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
        state.agentState = previousState;
        error(
          res,
          "Restart handler returned null — runtime failed to re-initialize",
          500,
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      state.agentState = previousState;
      error(res, `Restart failed: ${message}`, 500);
    }
    return true;
  }

  if (method === "POST" && pathname === "/api/agent/reset") {
    try {
      if (state.runtime) {
        await state.runtime.stop();
        state.runtime = null;
      }

      const stateDir = resolveStateDir();
      const config = loadElizaConfig();
      const dataDir = resolveResetPgliteDataDir(config, stateDir);
      if (path.basename(dataDir) !== ".elizadb") {
        logWarn(
          `[eliza-api] Refusing to delete unexpected PGlite dir during reset: "${dataDir}"`,
        );
      } else if (stateDirExists(dataDir)) {
        removeStateDir(dataDir);
      }

      clearPersistedOnboardingConfig(config);
      saveElizaConfig(config);

      // Wipe cloud-related vault entries so the next boot doesn't re-hydrate
      // the user back into a "signed in to Eliza Cloud" state. Without this,
      // /api/agent/reset clears the renderer UI but the vault still holds
      // ELIZAOS_CLOUD_API_KEY → vault-bootstrap rehydrates env on next start
      // → useCloudState reports cloud connected → user sees themselves still
      // logged in even though they just hit "Reset".
      try {
        const { sharedVault } = await importAppCoreRuntime();
        const vault = sharedVault();
        const cloudKeys = [
          "ELIZAOS_CLOUD_API_KEY",
          "ELIZAOS_CLOUD_BASE_URL",
          "ELIZAOS_CLOUD_ENABLED",
        ];
        for (const key of cloudKeys) {
          try {
            await vault.remove(key);
          } catch {
            // Entry may not exist — fine.
          }
        }
        // (No marker file to remove — vault-bootstrap is now keyed off
        // per-key vault.has() checks and re-evaluates cleanly on every boot.)
      } catch (vaultErr) {
        logWarn(
          `[eliza-api] Reset: failed to wipe cloud vault entries: ${vaultErr instanceof Error ? vaultErr.message : String(vaultErr)}`,
        );
      }

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
      error(res, `Reset failed: ${message}`, 500);
    }
    return true;
  }

  if (method === "POST" && pathname === "/api@elizaos/agent/reset") {
    try {
      if (state.runtime) {
        await state.runtime.stop();
        state.runtime = null;
      }

      const stateDir = resolveStateDir();
      const resolvedState = resolvePath(stateDir);
      const home = getHomeDir();
      const isSafe = isSafeResetStateDir(resolvedState, home);
      if (!isSafe) {
        logWarn(
          `[eliza-api] Refusing to delete unsafe state dir: "${resolvedState}"`,
        );
        error(
          res,
          `Reset aborted: state directory "${resolvedState}" does not appear safe to delete`,
          400,
        );
        return true;
      }

      if (stateDirExists(resolvedState)) {
        removeStateDir(resolvedState);
      }

      state.agentState = "stopped";
      state.agentName = getDefaultStylePreset().name;
      state.model = undefined;
      state.startedAt = undefined;
      state.config = {};
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
      error(res, `Reset failed: ${message}`, 500);
    }
    return true;
  }

  return false;
}
