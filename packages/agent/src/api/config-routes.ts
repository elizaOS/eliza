import type http from "node:http";
import { logger } from "@elizaos/core";
import {
  isElizaSettingsDebugEnabled,
  sanitizeForSettingsDebug,
  settingsDebugCloudSummary,
} from "@elizaos/shared";
import type { ElizaConfig } from "../config/config.js";
import { saveElizaConfig } from "../config/config.js";
import {
  normalizeDeploymentTargetConfig,
  normalizeLinkedAccountsConfig,
  normalizeServiceRoutingConfig,
} from "../contracts/service-routing.js";
import type { ReadJsonBodyOptions } from "./http-helpers.js";
import { applyCanonicalOnboardingConfig } from "./provider-switch-config.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ConfigRouteContext {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  method: string;
  pathname: string;
  url: URL;
  config: ElizaConfig;
  // Helpers from server.ts
  json: (res: http.ServerResponse, data: unknown, status?: number) => void;
  error: (res: http.ServerResponse, message: string, status?: number) => void;
  readJsonBody: <T extends object>(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    options?: ReadJsonBodyOptions,
  ) => Promise<T | null>;
  // Server.ts internal helpers passed through
  redactConfigSecrets: (
    config: Record<string, unknown>,
  ) => Record<string, unknown>;
  isBlockedObjectKey: (key: string) => boolean;
  stripRedactedPlaceholderValuesDeep: (value: unknown) => void;
  patchTouchesProviderSelection: (filtered: Record<string, unknown>) => boolean;
  BLOCKED_ENV_KEYS: Set<string>;
  CONFIG_WRITE_ALLOWED_TOP_KEYS: Set<string>;
  resolveMcpServersRejection: (
    servers: Record<string, unknown>,
  ) => Promise<string | null>;
  resolveMcpTerminalAuthorizationRejection: (
    req: http.IncomingMessage,
    servers: Record<string, unknown>,
    body: { terminalToken?: string },
  ) => { reason: string; status: number } | null;
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

/**
 * Handle configuration routes (GET/PUT /api/config, GET /api/config/schema).
 * Returns `true` if the request was handled.
 */
export async function handleConfigRoutes(
  ctx: ConfigRouteContext,
): Promise<boolean> {
  const {
    req,
    res,
    method,
    pathname,
    config,
    json,
    error,
    readJsonBody,
    redactConfigSecrets,
    isBlockedObjectKey,
    stripRedactedPlaceholderValuesDeep,
    patchTouchesProviderSelection: _patchTouchesProviderSelection,
    BLOCKED_ENV_KEYS,
    CONFIG_WRITE_ALLOWED_TOP_KEYS,
    resolveMcpServersRejection,
    resolveMcpTerminalAuthorizationRejection,
  } = ctx;

  // ── GET /api/config/schema ───────────────────────────────────────────────
  if (method === "GET" && pathname === "/api/config/schema") {
    const { buildConfigSchema } = await import("../config/schema.js");
    const result = buildConfigSchema();
    json(res, result);
    return true;
  }

  // ── GET /api/config ──────────────────────────────────────────────────────
  if (method === "GET" && pathname === "/api/config") {
    if (isElizaSettingsDebugEnabled()) {
      const cfg = config as Record<string, unknown>;
      const cloud = cfg.cloud as Record<string, unknown> | undefined;
      logger.debug(
        `[eliza][settings][api] GET /api/config → respond (redacted) topKeys=${Object.keys(cfg).sort().join(",")} cloud=${JSON.stringify(settingsDebugCloudSummary(cloud))}`,
      );
    }
    json(
      res,
      redactConfigSecrets(config as unknown as Record<string, unknown>),
    );
    return true;
  }

  // ── PUT /api/config ─────────────────────────────────────────────────────
  if (method === "PUT" && pathname === "/api/config") {
    const body = await readJsonBody(req, res);
    if (!body) return true;

    if (isElizaSettingsDebugEnabled()) {
      const b = body as Record<string, unknown>;
      const cloudBefore = (config as Record<string, unknown>).cloud as
        | Record<string, unknown>
        | undefined;
      logger.debug(
        `[eliza][settings][api] PUT /api/config ← body topKeys=${Object.keys(b).sort().join(",")} snapshot=${JSON.stringify(sanitizeForSettingsDebug(b))}`,
      );
      logger.debug(
        `[eliza][settings][api] PUT /api/config state.config.cloud(before)=${JSON.stringify(settingsDebugCloudSummary(cloudBefore))}`,
      );
    }

    // --- Security: validate and safely merge config updates ----------------

    /**
     * Deep-merge `src` into `target`, only touching keys present in `src`.
     * Prevents prototype pollution by rejecting dangerous key names at every
     * level.  Performs a recursive merge for plain objects so that partial
     * updates don't wipe sibling keys.
     */
    function safeMerge(
      target: Record<string, unknown>,
      src: Record<string, unknown>,
    ): void {
      for (const key of Object.keys(src)) {
        if (isBlockedObjectKey(key)) continue;
        const srcVal = src[key];
        const tgtVal = target[key];
        if (
          srcVal !== null &&
          typeof srcVal === "object" &&
          !Array.isArray(srcVal) &&
          tgtVal !== null &&
          typeof tgtVal === "object" &&
          !Array.isArray(tgtVal)
        ) {
          safeMerge(
            tgtVal as Record<string, unknown>,
            srcVal as Record<string, unknown>,
          );
        } else {
          target[key] = srcVal;
        }
      }
    }

    // Filter to allowed top-level keys, then deep-merge.
    const filtered: Record<string, unknown> = {};
    for (const key of Object.keys(body)) {
      if (CONFIG_WRITE_ALLOWED_TOP_KEYS.has(key) && !isBlockedObjectKey(key)) {
        filtered[key] = (body as Record<string, unknown>)[key];
      }
    }

    // Security: keep auth/step-up secrets out of API-driven config writes so
    // secret rotation remains an out-of-band operation.
    if (
      filtered.env &&
      typeof filtered.env === "object" &&
      !Array.isArray(filtered.env)
    ) {
      const envPatch = filtered.env as Record<string, unknown>;
      // Defense-in-depth: strip step-up secrets from persisted config before
      // merge, even though BLOCKED_ENV_KEYS also blocks them during process.env
      // sync below. Keeping both guards prevents accidental persistence if one
      // path changes in future refactors.
      delete envPatch.ELIZA_API_TOKEN;
      delete envPatch.ELIZA_API_TOKEN;
      delete envPatch.ELIZA_WALLET_EXPORT_TOKEN;
      delete envPatch.ELIZA_WALLET_EXPORT_TOKEN;
      delete envPatch.ELIZA_TERMINAL_RUN_TOKEN;
      delete envPatch.ELIZA_TERMINAL_RUN_TOKEN;
      delete envPatch.HYPERSCAPE_AUTH_TOKEN;
      delete envPatch.EVM_PRIVATE_KEY;
      delete envPatch.SOLANA_PRIVATE_KEY;
      delete envPatch.GITHUB_TOKEN;
      if (
        envPatch.vars &&
        typeof envPatch.vars === "object" &&
        !Array.isArray(envPatch.vars)
      ) {
        const vars = envPatch.vars as Record<string, unknown>;
        delete vars.ELIZA_API_TOKEN;
        delete vars.ELIZA_API_TOKEN;
        delete vars.ELIZA_WALLET_EXPORT_TOKEN;
        delete vars.ELIZA_WALLET_EXPORT_TOKEN;
        delete vars.ELIZA_TERMINAL_RUN_TOKEN;
        delete vars.ELIZA_TERMINAL_RUN_TOKEN;
        delete vars.HYPERSCAPE_AUTH_TOKEN;
        delete vars.EVM_PRIVATE_KEY;
        delete vars.SOLANA_PRIVATE_KEY;
        delete vars.GITHUB_TOKEN;
      }

      // Defense-in-depth: strip ALL BLOCKED_ENV_KEYS from the env patch
      // before safeMerge.  The explicit deletes above cover known step-up
      // secrets; this loop catches process-level injection keys
      // (NODE_OPTIONS, LD_PRELOAD, etc.) so they never reach
      // saveElizaConfig() and the persistence→restart RCE chain is closed.
      for (const key of Object.keys(envPatch)) {
        if (key === "vars" || key === "shellEnv") continue;
        if (BLOCKED_ENV_KEYS.has(key.toUpperCase())) {
          delete envPatch[key];
        }
      }
      if (
        envPatch.vars &&
        typeof envPatch.vars === "object" &&
        !Array.isArray(envPatch.vars)
      ) {
        const innerVars = envPatch.vars as Record<string, unknown>;
        for (const key of Object.keys(innerVars)) {
          if (BLOCKED_ENV_KEYS.has(key.toUpperCase())) {
            delete innerVars[key];
          }
        }
      }
    }

    if (
      filtered.mcp &&
      typeof filtered.mcp === "object" &&
      !Array.isArray(filtered.mcp)
    ) {
      const mcpPatch = filtered.mcp as Record<string, unknown>;
      if (mcpPatch.servers !== undefined) {
        if (
          !mcpPatch.servers ||
          typeof mcpPatch.servers !== "object" ||
          Array.isArray(mcpPatch.servers)
        ) {
          error(res, "mcp.servers must be a JSON object", 400);
          return true;
        }
        const mcpRejection = await resolveMcpServersRejection(
          mcpPatch.servers as Record<string, unknown>,
        );
        if (mcpRejection) {
          error(res, mcpRejection, 400);
          return true;
        }
        const mcpTerminalRejection = resolveMcpTerminalAuthorizationRejection(
          req,
          mcpPatch.servers as Record<string, unknown>,
          body as { terminalToken?: string },
        );
        if (mcpTerminalRejection) {
          error(
            res,
            `Configuring stdio MCP servers via /api/config requires terminal authorization. ${mcpTerminalRejection.reason}`,
            mcpTerminalRejection.status,
          );
          return true;
        }
      }
    }

    // Strip "[REDACTED]" from the whole patch (GET → PUT round-trips).
    stripRedactedPlaceholderValuesDeep(filtered);

    const explicitConnectionRequested = Object.hasOwn(
      body as Record<string, unknown>,
      "connection",
    );
    const canonicalDeploymentTargetRequested = Object.hasOwn(
      filtered,
      "deploymentTarget",
    );
    const canonicalLinkedAccountsRequested = Object.hasOwn(
      filtered,
      "linkedAccounts",
    );
    const canonicalServiceRoutingRequested = Object.hasOwn(
      filtered,
      "serviceRouting",
    );
    const normalizedDeploymentTarget = canonicalDeploymentTargetRequested
      ? normalizeDeploymentTargetConfig(filtered.deploymentTarget)
      : undefined;
    const normalizedLinkedAccounts = canonicalLinkedAccountsRequested
      ? normalizeLinkedAccountsConfig(filtered.linkedAccounts)
      : undefined;
    const normalizedServiceRouting = canonicalServiceRoutingRequested
      ? normalizeServiceRoutingConfig(filtered.serviceRouting)
      : undefined;
    if (explicitConnectionRequested) {
      error(
        res,
        "connection patches are no longer supported; update deploymentTarget, linkedAccounts, and serviceRouting directly",
        400,
      );
      return true;
    }

    if (isElizaSettingsDebugEnabled()) {
      logger.debug(
        `[eliza][settings][api] PUT /api/config filtered topKeys=${Object.keys(filtered).sort().join(",")} snapshot=${JSON.stringify(sanitizeForSettingsDebug(filtered))}`,
      );
    }

    safeMerge(config as Record<string, unknown>, filtered);

    // If the client updated env vars, synchronise them into process.env so
    // subsequent hot-restarts see the latest values (loadElizaConfig()
    // only fills missing env vars and does not override existing ones).
    if (
      filtered.env &&
      typeof filtered.env === "object" &&
      !Array.isArray(filtered.env)
    ) {
      const envPatch = filtered.env as Record<string, unknown>;

      // 1) env.vars.* (preferred)
      const vars = envPatch.vars;
      if (vars && typeof vars === "object" && !Array.isArray(vars)) {
        for (const [k, v] of Object.entries(vars as Record<string, unknown>)) {
          if (BLOCKED_ENV_KEYS.has(k.toUpperCase())) continue;
          const str = typeof v === "string" ? v : "";
          if (str.trim()) {
            process.env[k] = str;
          } else {
            delete process.env[k];
          }
        }
      }

      // 2) Direct env.* string keys (legacy)
      for (const [k, v] of Object.entries(envPatch)) {
        if (k === "vars" || k === "shellEnv") continue;
        if (BLOCKED_ENV_KEYS.has(k.toUpperCase())) continue;
        if (typeof v !== "string") continue;
        if (v.trim()) process.env[k] = v;
        else delete process.env[k];
      }

      // Keep config clean: drop empty env.vars entries so we don't persist
      // null/empty-string tombstones forever.
      const cfgEnv = (config as Record<string, unknown>).env;
      if (cfgEnv && typeof cfgEnv === "object" && !Array.isArray(cfgEnv)) {
        const cfgVars = (cfgEnv as Record<string, unknown>).vars;
        if (cfgVars && typeof cfgVars === "object" && !Array.isArray(cfgVars)) {
          for (const [k, v] of Object.entries(
            cfgVars as Record<string, unknown>,
          )) {
            if (typeof v !== "string" || !v.trim()) {
              delete (cfgVars as Record<string, unknown>)[k];
            }
          }
        }
      }
    }

    if (
      canonicalDeploymentTargetRequested ||
      canonicalLinkedAccountsRequested ||
      canonicalServiceRoutingRequested
    ) {
      applyCanonicalOnboardingConfig(config, {
        deploymentTarget: normalizedDeploymentTarget,
        linkedAccounts: normalizedLinkedAccounts,
        serviceRouting: normalizedServiceRouting,
      });
    }

    try {
      saveElizaConfig(config);
      if (isElizaSettingsDebugEnabled()) {
        const cfg = config as Record<string, unknown>;
        const cloud = cfg.cloud as Record<string, unknown> | undefined;
        logger.debug(
          `[eliza][settings][api] PUT /api/config → saveElizaConfig OK cloud(after)=${JSON.stringify(settingsDebugCloudSummary(cloud))}`,
        );
      }
    } catch (err) {
      logger.warn(
        `[api] Config save failed: ${err instanceof Error ? err.message : err}`,
      );
    }
    json(
      res,
      redactConfigSecrets(config as unknown as Record<string, unknown>),
    );
    return true;
  }

  return false;
}
