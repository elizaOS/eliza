import type http from "node:http";
import { ElizaError, logger } from "@elizaos/core";
import {
  PostPluginCoreToggleRequestSchema,
  PutPluginRequestSchema,
  PutSecretsRequestSchema,
} from "@elizaos/core/contracts/plugin-routes";
import { type ElizaConfig, saveElizaConfig } from "../config/config.ts";
import {
  isDevCloudEnvOwnedKey,
  resolveDevCloudEnvAuthority,
} from "../config/dev-cloud-env-authority.ts";
import {
  CONNECTOR_ENV_MAP,
  collectConfigEnvVars,
  collectConnectorEnvVars,
} from "../config/env-vars.ts";
import {
  applyAdvancedCapabilitiesConfig,
  isAdvancedCapabilityPluginId,
} from "../runtime/advanced-capabilities-config.ts";
import {
  CORE_PLUGINS,
  OPTIONAL_CORE_PLUGINS,
} from "../runtime/core-plugins.ts";
import {
  aggregateSecrets,
  isBlockedEnvKey,
} from "./plugin-discovery-helpers.ts";
import { applyPluginRuntimeMutation } from "./plugin-runtime-apply.ts";
import { validatePluginConfig } from "./plugin-validation.ts";
import type { PluginEntry, ServerState } from "./server-types.ts";

export interface PluginManagementRouteContext {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  method: string;
  pathname: string;
  state: Pick<ServerState, "runtime" | "config">;
  isOwner: boolean;
  getPlugins: () => Promise<PluginEntry[]>;
  readJsonBody: <T = Record<string, unknown>>(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ) => Promise<T | null>;
  json: (res: http.ServerResponse, data: unknown, status?: number) => void;
  error: (res: http.ServerResponse, message: string, status?: number) => void;
  scheduleRuntimeRestart: (reason: string) => void;
  restartRuntime?: (reason: string) => Promise<boolean>;
}

// Serialize config read/modify/persist within one host; rejected operations must
// release the queue without allowing a stale snapshot to overwrite a later save.
const writes = new WeakMap<
  PluginManagementRouteContext["state"],
  Promise<void>
>();
async function serializeWrite(
  ctx: PluginManagementRouteContext,
  action: () => Promise<void>,
): Promise<void> {
  const previous = writes.get(ctx.state) ?? Promise.resolve();
  let release = () => {};
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  writes.set(ctx.state, current);
  await previous;
  try {
    await action();
  } finally {
    release();
    if (writes.get(ctx.state) === current) writes.delete(ctx.state);
  }
}

function pluginId(name: string): string {
  return name.replace(/^@[^/]+\//, "").replace(/^plugin-/, "");
}

function canonicalEntry(
  config: ElizaConfig,
  plugin: Pick<PluginEntry, "id" | "npmName">,
) {
  config.plugins ??= {};
  config.plugins.entries ??= {};
  const npmName = plugin.npmName ?? `@elizaos/plugin-${plugin.id}`;
  const scoped = config.plugins.entries[npmName];
  const short = config.plugins.entries[plugin.id];
  const entry = {
    ...scoped,
    ...short,
    config: { ...scoped?.config, ...short?.config },
  };
  config.plugins.entries[plugin.id] = entry;
  if (npmName !== plugin.id) delete config.plugins.entries[npmName];
  return entry;
}

function clearCredentialSources(config: ElizaConfig, key: string) {
  if (config.env) {
    delete config.env[key];
    if (config.env.vars) delete config.env.vars[key];
  }
  for (const [connector, fields] of Object.entries(CONNECTOR_ENV_MAP)) {
    const settings = config.connectors?.[connector];
    if (!settings || typeof settings !== "object") continue;
    for (const [field, envKey] of Object.entries(fields))
      if (envKey === key) delete (settings as Record<string, unknown>)[field];
  }
}

function toggle(
  config: ElizaConfig,
  id: string,
  npmName: string,
  enabled: boolean,
): void {
  canonicalEntry(config, { id, npmName }).enabled = enabled;
  config.plugins ??= {};
  const allow = (config.plugins.allow ?? []).filter(
    (entry) => entry !== id && entry !== npmName,
  );
  config.plugins.allow = enabled ? [...allow, npmName] : allow;
  if (isAdvancedCapabilityPluginId(id))
    applyAdvancedCapabilitiesConfig(config, enabled);
  if (["vision", "browser", "computeruse", "coding-agent"].includes(id)) {
    config.features ??= {};
    config.features[id] = enabled;
  }
}

function explicitlyDisabled(config: ElizaConfig, plugin: PluginEntry): boolean {
  return (
    config.plugins?.entries?.[plugin.id]?.enabled === false ||
    config.plugins?.entries?.[plugin.npmName ?? `@elizaos/plugin-${plugin.id}`]
      ?.enabled === false
  );
}

function valueFor(
  ctx: PluginManagementRouteContext,
  plugin: PluginEntry,
  key: string,
): string | undefined {
  const value =
    (
      ctx.state.config.plugins?.entries?.[plugin.id] ??
      ctx.state.config.plugins?.entries?.[
        plugin.npmName ?? `@elizaos/plugin-${plugin.id}`
      ]
    )?.config?.[key] ??
    collectConfigEnvVars(ctx.state.config)[key] ??
    collectConnectorEnvVars(ctx.state.config)[key];
  if (typeof value === "string") return value;
  const runtimeValue = ctx.state.runtime?.getSetting(key);
  return typeof runtimeValue === "string" ? runtimeValue : process.env[key];
}

function validateKeys(
  plugins: PluginEntry[],
  values: Record<string, string>,
  secretsOnly: boolean,
): string | null {
  const allowed = new Map(
    plugins.flatMap((plugin) =>
      plugin.parameters
        .filter((param) => !secretsOnly || param.sensitive)
        .map((param) => [param.key, param] as const),
    ),
  );
  for (const [key, value] of Object.entries(values)) {
    const param = allowed.get(key);
    if (!param || isBlockedEnvKey(key))
      return `${key} is not an allowed configuration key`;
    if (resolveDevCloudEnvAuthority() && isDevCloudEnvOwnedKey(key))
      return `${key} is controlled by the development launcher`;
    if (
      !secretsOnly &&
      !value.trim() &&
      plugins.some((plugin) =>
        plugin.parameters.some(
          (parameter) =>
            parameter.key === key && parameter.required && !parameter.default,
        ),
      )
    )
      return `${key} is required`;
  }
  return null;
}

async function persistMutation(
  ctx: PluginManagementRouteContext,
  plugin: PluginEntry,
  values: Record<string, string>,
  enabled?: boolean,
): Promise<void> {
  if (
    enabled !== undefined &&
    resolveDevCloudEnvAuthority() &&
    plugin.parameters.some((param) => isDevCloudEnvOwnedKey(param.key))
  ) {
    ctx.error(ctx.res, "Plugin is controlled by the development launcher", 409);
    return;
  }
  const previousConfig = ctx.state.config;
  const nextConfig = structuredClone(previousConfig);
  const entry = canonicalEntry(nextConfig, plugin);
  nextConfig.env ??= {};
  for (const [key, value] of Object.entries(values)) {
    if (value.trim()) {
      entry.config[key] = value;
      nextConfig.env[key] = value;
    } else {
      entry.config[key] = "";
      clearCredentialSources(nextConfig, key);
    }
  }
  const npmName = plugin.npmName ?? `@elizaos/plugin-${plugin.id}`;
  if (enabled !== undefined) toggle(nextConfig, plugin.id, npmName, enabled);
  // Persistence failure must leave the live configuration untouched and fail the request.
  saveElizaConfig(nextConfig);
  ctx.state.config = nextConfig;
  for (const param of plugin.parameters) {
    if (
      enabled === false ||
      (enabled === undefined && explicitlyDisabled(nextConfig, plugin))
    )
      ctx.state.runtime?.setSetting(param.key, null, param.sensitive);
    else if (enabled === true || Object.hasOwn(values, param.key)) {
      const value = valueFor(ctx, plugin, param.key);
      ctx.state.runtime?.setSetting(
        param.key,
        typeof value === "string" && value.trim() ? value : null,
        param.sensitive,
      );
    }
  }
  if (enabled !== undefined && isAdvancedCapabilityPluginId(plugin.id)) {
    ctx.state.runtime?.setSetting("ADVANCED_CAPABILITIES", String(enabled));
    ctx.state.runtime?.setSetting(
      "ENABLE_EXTENDED_CAPABILITIES",
      String(enabled),
    );
  }
  const applied = await applyPluginRuntimeMutation({
    runtime: ctx.state.runtime,
    previousConfig,
    nextConfig,
    changedPluginId: plugin.id,
    changedPluginPackage: npmName,
    config: values,
    expectRuntimeGraphChange: enabled !== undefined,
    reason: `Plugin configuration changed: ${plugin.id}`,
    ...(ctx.restartRuntime ? { restartRuntime: ctx.restartRuntime } : {}),
  });
  if (applied.requiresRestart) ctx.scheduleRuntimeRestart(applied.reason);
  const refreshed = (await ctx.getPlugins()).find(
    (item) => item.id === plugin.id,
  );
  ctx.json(ctx.res, {
    ok: true,
    plugin: refreshed,
    applied: applied.mode,
    requiresRestart: applied.requiresRestart,
    restartedRuntime: applied.restartedRuntime,
    loadedPackages: applied.loadedPackages,
    unloadedPackages: applied.unloadedPackages,
    reloadedPackages: applied.reloadedPackages,
  });
}

async function dispatchPluginManagementRoutes(
  ctx: PluginManagementRouteContext,
): Promise<boolean> {
  const { method, pathname, req, res, json, error } = ctx;
  const secrets =
    pathname === "/api/secrets" && (method === "GET" || method === "PUT");
  const coreToggle =
    pathname === "/api/plugins/core/toggle" && method === "POST";
  const update =
    method === "PUT" ? pathname.match(/^\/api\/plugins\/([^/]+)$/) : null;
  const probe =
    method === "POST"
      ? pathname.match(/^\/api\/plugins\/([^/]+)\/test$/)
      : null;
  if (!secrets && !coreToggle && !update && !probe) return false;
  if (!ctx.isOwner) {
    error(res, "Owner role required", 403);
    return true;
  }
  let id: string | undefined;
  if (update || probe) {
    try {
      id = decodeURIComponent((update ?? probe)?.[1] ?? "");
    } catch {
      error(res, "Malformed plugin id", 400);
      return true;
    }
  }
  if (probe) {
    const plugin = ctx.state.runtime?.plugins.find(
      (item) => pluginId(item.name) === pluginId(id ?? ""),
    );
    if (!plugin) {
      error(res, "Plugin is not loaded", 404);
      return true;
    }
    const record = plugin as unknown as Record<string, unknown>;
    const health = ["health", "healthCheck", "testConnection", "test"]
      .map((key) => record[key])
      .find((value) => typeof value === "function");
    if (typeof health !== "function") {
      error(res, "Plugin does not expose a connection test", 501);
      return true;
    }
    const started = Date.now();
    const controller = new AbortController();
    let rejectStopped: (error: Error) => void = () => {};
    const stopped = new Promise<never>((_, reject) => {
      rejectStopped = reject;
    });
    const stop = () => {
      const failure = new ElizaError(
        "Plugin connection test cancelled or timed out",
        { code: "PLUGIN_PROBE_CANCELLED" },
      );
      controller.abort(failure);
      rejectStopped(failure);
    };
    const timer = setTimeout(stop, 10_000);
    res.once("close", stop);
    let result: unknown;
    try {
      result = await Promise.race([
        Promise.resolve().then(() =>
          health.call(plugin, { signal: controller.signal }),
        ),
        stopped,
      ]);
    } finally {
      clearTimeout(timer);
      res.off("close", stop);
    }
    if (
      !result ||
      typeof result !== "object" ||
      !("ok" in result) ||
      typeof result.ok !== "boolean"
    ) {
      error(res, "Plugin returned an invalid connection test result", 502);
      return true;
    }
    json(res, {
      success: result.ok,
      pluginId: id,
      message: result.ok ? "Connection successful" : "Connection failed",
      durationMs: Date.now() - started,
    });
    return true;
  }
  if (secrets && method === "GET") {
    const plugins = await ctx.getPlugins();
    const entries = aggregateSecrets(plugins);
    for (const entry of entries) {
      const isSet = plugins.some(
        (plugin) =>
          plugin.parameters.some((param) => param.key === entry.key) &&
          Boolean(valueFor(ctx, plugin, entry.key)?.trim()),
      );
      entry.isSet = isSet;
      entry.maskedValue = isSet ? "********" : null;
    }
    json(res, { secrets: entries });
    return true;
  }
  const body = await ctx.readJsonBody(req, res);
  if (body === null) return true;
  const schema = secrets
    ? PutSecretsRequestSchema
    : coreToggle
      ? PostPluginCoreToggleRequestSchema
      : PutPluginRequestSchema;
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    error(res, "Invalid plugin configuration request", 400);
    return true;
  }
  await serializeWrite(ctx, async () => {
    const plugins = await ctx.getPlugins();
    if (secrets) {
      const values = PutSecretsRequestSchema.parse(body).secrets;
      const rejection = validateKeys(plugins, values, true);
      if (rejection) {
        error(res, rejection, 422);
        return;
      }
      const previousConfig = ctx.state.config;
      const next = structuredClone(previousConfig);
      next.env ??= {};
      next.plugins ??= {};
      next.plugins.entries ??= {};
      for (const [key, value] of Object.entries(values)) {
        if (value.trim()) next.env[key] = value;
        else clearCredentialSources(next, key);
        for (const plugin of plugins.filter((item) =>
          item.parameters.some((param) => param.key === key && param.sensitive),
        )) {
          const entry = canonicalEntry(next, plugin);
          entry.config[key] = value.trim() ? value : "";
        }
      }
      saveElizaConfig(next);
      ctx.state.config = next;
      for (const [key, value] of Object.entries(values))
        ctx.state.runtime?.setSetting(
          key,
          value.trim() &&
            plugins.some(
              (plugin) =>
                !explicitlyDisabled(next, plugin) &&
                plugin.parameters.some((param) => param.key === key),
            )
            ? value
            : null,
          true,
        );
      const applications = [];
      for (const plugin of plugins.filter(
        (item) =>
          !explicitlyDisabled(next, item) &&
          item.parameters.some((param) => Object.hasOwn(values, param.key)),
      )) {
        const config = Object.fromEntries(
          Object.entries(values).filter(([key]) =>
            plugin.parameters.some((param) => param.key === key),
          ),
        );
        const applied = await applyPluginRuntimeMutation({
          runtime: ctx.state.runtime,
          previousConfig,
          nextConfig: next,
          changedPluginId: plugin.id,
          changedPluginPackage:
            plugin.npmName ?? `@elizaos/plugin-${plugin.id}`,
          config,
          reason: `Plugin credentials changed: ${plugin.id}`,
          configurationOnly: true,
          ...(ctx.restartRuntime ? { restartRuntime: ctx.restartRuntime } : {}),
        });
        if (applied.requiresRestart) ctx.scheduleRuntimeRestart(applied.reason);
        applications.push({ pluginId: plugin.id, ...applied });
      }
      json(res, {
        ok: true,
        updated: Object.keys(values),
        applications,
        requiresRestart: applications.some((entry) => entry.requiresRestart),
      });
      return;
    }
    if (coreToggle) {
      const { npmName, enabled } =
        PostPluginCoreToggleRequestSchema.parse(body);
      if (
        (CORE_PLUGINS as readonly string[]).includes(npmName) ||
        !(OPTIONAL_CORE_PLUGINS as readonly string[]).includes(npmName)
      ) {
        error(res, "Only optional core plugins can be toggled", 400);
        return;
      }
      const plugin = plugins.find(
        (item) => item.npmName === npmName || item.id === pluginId(npmName),
      );
      if (!plugin) {
        error(res, "Optional plugin is not installed", 404);
        return;
      }
      await persistMutation(ctx, plugin, {}, enabled);
      return;
    }
    const plugin = plugins.find(
      (item) => item.id === id || item.npmName === id,
    );
    if (!plugin) {
      error(res, "Plugin not found", 404);
      return;
    }
    const { config = {}, enabled } = PutPluginRequestSchema.parse(body);
    const rejection = validateKeys([plugin], config, false);
    if (rejection) {
      error(res, rejection, 422);
      return;
    }
    if (
      enabled === false &&
      (CORE_PLUGINS as readonly string[]).includes(
        plugin.npmName ?? `@elizaos/plugin-${plugin.id}`,
      )
    ) {
      error(res, "Required core plugins cannot be disabled", 400);
      return;
    }
    const validation = validatePluginConfig(
      plugin.id,
      plugin.category,
      plugin.envKey,
      plugin.configKeys,
      config,
      plugin.parameters.filter((param) => Object.hasOwn(config, param.key)),
    );
    if (Object.keys(config).length > 0 && !validation.valid) {
      json(res, { ok: false, validationErrors: validation.errors }, 422);
      return;
    }
    await persistMutation(ctx, plugin, config, enabled);
  });
  return true;
}

export async function handlePluginManagementRoutes(
  ctx: PluginManagementRouteContext,
): Promise<boolean> {
  try {
    return await dispatchPluginManagementRoutes(ctx);
  } catch {
    // error-policy:J6 Provider exceptions may embed credentials. Record a typed,
    // non-secret failure and fail the HTTP operation without exposing its payload.
    ctx.state.runtime?.reportError(
      "plugin-management",
      new ElizaError("Plugin management operation failed", {
        code: "PLUGIN_MANAGEMENT_FAILED",
      }),
    );
    logger.error("[plugin-management] Operation failed");
    if (!ctx.res.destroyed && !ctx.res.writableEnded)
      ctx.error(ctx.res, "Plugin management operation failed", 500);
    return true;
  }
}
