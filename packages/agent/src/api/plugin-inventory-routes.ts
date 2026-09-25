/** Read-only catalog and live registration inventory for the authenticated host API. */
import type http from "node:http";
import {
  collectConfigEnvVars,
  collectConnectorEnvVars,
} from "../config/env-vars.ts";
import {
  CORE_PLUGINS,
  OPTIONAL_CORE_PLUGINS,
} from "../runtime/core-plugins.ts";
import {
  categorizePlugin,
  discoverInstalledPlugins,
  discoverPluginsFromManifest,
  formatPluginName,
} from "./plugin-discovery-helpers.ts";
import { validatePluginConfig } from "./plugin-validation.ts";
import type { PluginEntry, ServerState } from "./server-types.ts";

type InventoryState = Pick<ServerState, "config" | "runtime" | "plugins">;
const pluginId = (name: string): string =>
  name.replace(/^@[^/]+\//, "").replace(/^plugin-/, "");
const sensitiveKey = (key: string): boolean =>
  /(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|SIGNING|ENCRYPTION)/i.test(key);

/** Rebuild values on every read; configured/enabled never stand in for registration. */
export function getPluginInventory(state: InventoryState): PluginEntry[] {
  const failures = new Set(
    state.plugins.filter((entry) => entry.loadError).map((entry) => entry.id),
  );
  const bundled = discoverPluginsFromManifest();
  const catalog = new Map(state.plugins.map((entry) => [entry.id, entry]));
  for (const entry of bundled) catalog.set(entry.id, entry);
  for (const entry of discoverInstalledPlugins(
    state.config,
    new Set(bundled.map((entry) => entry.id)),
  ))
    catalog.set(entry.id, entry);
  for (const plugin of state.runtime?.plugins ?? []) {
    const id = pluginId(plugin.name);
    if (catalog.has(id)) continue;
    catalog.set(id, {
      id,
      name: plugin.name,
      description: plugin.description ?? "",
      tags: [],
      enabled: true,
      configured: true,
      envKey: null,
      category: categorizePlugin(id),
      source: "store",
      configKeys: [],
      parameters: [],
      validationErrors: [],
      validationWarnings: [],
    });
  }
  const loaded = new Set(
    (state.runtime?.plugins ?? []).map((plugin) => pluginId(plugin.name)),
  );
  const env = {
    ...collectConnectorEnvVars(state.config),
    ...collectConfigEnvVars(state.config),
  };
  const entries = state.config.plugins?.entries;
  return [...catalog.values()]
    .map((entry) => {
      const configuredEntry =
        entries?.[entry.id] ??
        (entry.npmName ? entries?.[entry.npmName] : undefined);
      const supplied = configuredEntry?.config ?? {};
      const configKeys = [
        ...new Set([
          ...entry.configKeys,
          ...entry.parameters.map((parameter) => parameter.key),
          ...(entry.envKey ? [entry.envKey] : []),
        ]),
      ];
      const values: Record<string, string> = {};
      const parameters = entry.parameters.map((parameter) => {
        const raw =
          supplied[parameter.key] ??
          env[parameter.key] ??
          process.env[parameter.key];
        const value =
          typeof raw === "string" ? raw : raw == null ? "" : String(raw);
        values[parameter.key] = value;
        const sensitive = parameter.sensitive || sensitiveKey(parameter.key);
        return {
          ...parameter,
          sensitive,
          default: sensitive ? undefined : parameter.default,
          isSet: Boolean(value.trim()),
          currentValue: value.trim() ? (sensitive ? "****" : value) : null,
        };
      });
      for (const key of configKeys) {
        if (key in values) continue;
        const raw = supplied[key] ?? env[key] ?? process.env[key];
        values[key] =
          typeof raw === "string" ? raw : raw == null ? "" : String(raw);
      }
      const validation = validatePluginConfig(
        entry.id,
        entry.category,
        entry.envKey,
        configKeys,
        values,
        parameters,
      );
      const isActive =
        loaded.has(entry.id) || loaded.has(pluginId(entry.npmName ?? entry.id));
      const disabled =
        entries?.[entry.id]?.enabled === false ||
        (entry.npmName !== undefined &&
          entries?.[entry.npmName]?.enabled === false);
      const enabled =
        !disabled &&
        (configuredEntry?.enabled === true ||
          isActive ||
          entry.source === "store" ||
          CORE_PLUGINS.includes(entry.npmName ?? ""));
      // Discovery metadata is public; cached runtime errors and arbitrary hint
      // values are not part of the read contract and can contain credentials.
      const { loadError: _loadError, configUiHints, ...metadata } = entry;
      const hints = configUiHints
        ? Object.fromEntries(
            Object.entries(configUiHints).map(([key, hint]) => [
              key,
              Object.fromEntries(
                Object.entries(hint).filter(([field]) =>
                  [
                    "label",
                    "help",
                    "group",
                    "order",
                    "advanced",
                    "sensitive",
                    "placeholder",
                  ].includes(field),
                ),
              ),
            ]),
          )
        : undefined;
      return {
        ...metadata,
        ...(hints ? { configUiHints: hints } : {}),
        enabled,
        isActive,
        ...(!isActive && failures.has(entry.id)
          ? { loadError: "Plugin failed to load; inspect host diagnostics" }
          : {}),
        configured: validation.valid,
        configKeys,
        parameters,
        validationErrors: validation.errors,
        validationWarnings: validation.warnings,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function handlePluginInventoryRoutes(ctx: {
  res: http.ServerResponse;
  method: string;
  pathname: string;
  state: InventoryState;
  json: (res: http.ServerResponse, data: unknown, status?: number) => void;
}): boolean {
  if (
    ctx.method !== "GET" ||
    !["/api/plugins", "/api/plugins/core"].includes(ctx.pathname)
  )
    return false;
  const plugins = getPluginInventory(ctx.state);
  if (ctx.pathname === "/api/plugins") ctx.json(ctx.res, { plugins });
  else {
    const byId = new Map(plugins.map((entry) => [entry.id, entry]));
    const coreEntry = (npmName: string, isCore: boolean) => {
      const id = pluginId(npmName);
      const entry = byId.get(id);
      const configured = ctx.state.config.plugins?.entries;
      const disabled =
        configured?.[id]?.enabled === false ||
        configured?.[npmName]?.enabled === false;
      return {
        npmName,
        id,
        name: entry?.name ?? formatPluginName(id),
        isCore,
        loaded: entry?.isActive ?? false,
        enabled:
          !disabled &&
          (entry?.enabled ??
            (isCore ||
              configured?.[id]?.enabled === true ||
              configured?.[npmName]?.enabled === true)),
      };
    };
    ctx.json(ctx.res, {
      core: CORE_PLUGINS.map((name) => coreEntry(name, true)),
      optional: OPTIONAL_CORE_PLUGINS.map((name) => coreEntry(name, false)),
    });
  }
  return true;
}
