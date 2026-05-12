import { Switch } from "../ui/switch";
import { useCallback, useMemo, useRef, useState } from "react";
import type { PluginInfo, PluginParamDef } from "../../api";
import {
  ConfigRenderer,
  defaultRegistry,
} from "../../components/config-ui/config-renderer";
import { useApp } from "../../state";
import type { ConfigUiHint } from "../../types";
import { paramsToSchema, TELEGRAM_ALLOW_ALL_HIDDEN } from "./plugin-list-utils";

/* ── Telegram chat mode ─────────────────────────────────────────────── */

/**
 * Hook that manages the "allow all / specific chats" toggle state.
 * Mode is explicit (not derived from field value) so clearing the field
 * doesn't flip the toggle. Returns the mode, a toggle handler, and
 * hiddenKeys for PluginConfigForm.
 */
export function useTelegramChatMode(
  plugin: PluginInfo,
  pluginConfigs: Record<string, Record<string, string>>,
  onParamChange: (pluginId: string, paramKey: string, value: string) => void,
) {
  const localValue = pluginConfigs.telegram?.TELEGRAM_ALLOWED_CHATS;
  const serverValue =
    plugin.parameters?.find((p) => p.key === "TELEGRAM_ALLOWED_CHATS")
      ?.currentValue ?? "";
  const currentValue = localValue ?? serverValue;

  // Explicit mode state — initialized from current value, then user-controlled
  const [allowAll, setAllowAll] = useState(() => !currentValue.trim());

  // Stash the last non-empty value so toggling back restores it
  const stashedChats = useRef(currentValue);
  if (currentValue.trim()) {
    stashedChats.current = currentValue;
  }

  const toggle = useCallback(
    (next: boolean) => {
      setAllowAll(next);
      if (next) {
        onParamChange("telegram", "TELEGRAM_ALLOWED_CHATS", "");
      } else {
        const restore = stashedChats.current?.trim() || "[]";
        onParamChange("telegram", "TELEGRAM_ALLOWED_CHATS", restore);
      }
    },
    [onParamChange],
  );

  return {
    allowAll,
    toggle,
    hiddenKeys: allowAll ? TELEGRAM_ALLOW_ALL_HIDDEN : undefined,
  };
}

export function TelegramChatModeToggle({
  allowAll,
  onToggle,
}: {
  allowAll: boolean;
  onToggle: (next: boolean) => void;
}) {
  const { t } = useApp();
  return (
    <div className="flex items-center justify-between rounded-lg border border-border bg-[var(--card,rgba(255,255,255,0.03))] px-4 py-3 mb-4">
      <div className="flex flex-col gap-0.5">
        <span className="text-sm font-semibold text-txt">
          {allowAll
            ? t("pluginsview.AllowAllChats", {
                defaultValue: "Allow all chats",
              })
            : t("pluginsview.AllowSpecificChatsOnly", {
                defaultValue: "Allow only specific chats",
              })}
        </span>
        <span className="text-xs-tight text-muted">
          {allowAll
            ? t("pluginsview.BotRespondsAnyChat", {
                defaultValue: "Bot will respond in any chat",
              })
            : t("pluginsview.BotRespondsListedChatIds", {
                defaultValue: "Bot will only respond in listed chat IDs",
              })}
        </span>
      </div>
      <Switch checked={allowAll} onCheckedChange={onToggle} />
    </div>
  );
}

/** Wraps PluginConfigForm with the Telegram chat mode toggle + hidden keys. */
export function TelegramPluginConfig({
  plugin,
  pluginConfigs,
  onParamChange,
}: {
  plugin: PluginInfo;
  pluginConfigs: Record<string, Record<string, string>>;
  onParamChange: (pluginId: string, paramKey: string, value: string) => void;
}) {
  const { allowAll, toggle, hiddenKeys } = useTelegramChatMode(
    plugin,
    pluginConfigs,
    onParamChange,
  );

  return (
    <>
      <TelegramChatModeToggle allowAll={allowAll} onToggle={toggle} />
      <PluginConfigForm
        plugin={plugin}
        pluginConfigs={pluginConfigs}
        onParamChange={onParamChange}
        hiddenKeys={hiddenKeys}
      />
    </>
  );
}

/* ── PluginConfigForm bridge ─────────────────────────────────────────── */

export function PluginConfigForm({
  plugin,
  pluginConfigs,
  onParamChange,
  hiddenKeys,
}: {
  plugin: PluginInfo;
  pluginConfigs: Record<string, Record<string, string>>;
  onParamChange: (pluginId: string, paramKey: string, value: string) => void;
  hiddenKeys?: Set<string>;
}) {
  const params = plugin.parameters ?? [];
  const { schema, hints: autoHints } = useMemo(
    () => paramsToSchema(params, plugin.id),
    [params, plugin.id],
  );

  // Merge server-provided configUiHints over auto-generated hints.
  // Server hints take priority (override auto-generated ones).
  // Also apply hiddenKeys from parent (e.g. Telegram chat mode toggle).
  const hints = useMemo(() => {
    const merged: Record<string, ConfigUiHint> = { ...autoHints };
    const serverHints = plugin.configUiHints;
    if (serverHints) {
      for (const [key, serverHint] of Object.entries(serverHints)) {
        merged[key] = { ...merged[key], ...serverHint };
      }
    }
    if (hiddenKeys) {
      for (const key of hiddenKeys) {
        merged[key] = { ...merged[key], hidden: true };
      }
    }
    return merged;
  }, [autoHints, plugin.configUiHints, hiddenKeys]);

  // Build values from current config state + existing server values.
  // Array-typed fields need comma-separated strings parsed into arrays.
  const values = useMemo(() => {
    const v: Record<string, unknown> = {};
    const props = (schema.properties ?? {}) as Record<
      string,
      Record<string, unknown>
    >;
    for (const p of params) {
      const isArrayField = props[p.key]?.type === "array";
      const configValue = pluginConfigs[plugin.id]?.[p.key];
      if (configValue !== undefined) {
        if (isArrayField && typeof configValue === "string") {
          v[p.key] = configValue
            ? configValue
                .split(",")
                .map((s: string) => s.trim())
                .filter(Boolean)
            : [];
        } else {
          v[p.key] = configValue;
        }
      } else if (p.isSet && !p.sensitive && p.currentValue != null) {
        if (isArrayField && typeof p.currentValue === "string") {
          v[p.key] = String(p.currentValue)
            ? String(p.currentValue)
                .split(",")
                .map((s: string) => s.trim())
                .filter(Boolean)
            : [];
        } else {
          v[p.key] = p.currentValue;
        }
      }
    }
    return v;
  }, [params, plugin.id, pluginConfigs, schema]);

  const setKeys = useMemo(
    () =>
      new Set(
        params
          .filter((p: PluginParamDef) => p.isSet)
          .map((p: PluginParamDef) => p.key),
      ),
    [params],
  );

  const handleChange = useCallback(
    (key: string, value: unknown) => {
      // Join array values back to comma-separated strings for env var storage
      const stringValue = Array.isArray(value)
        ? value.join(", ")
        : String(value ?? "");
      onParamChange(plugin.id, key, stringValue);
    },
    [plugin.id, onParamChange],
  );

  return (
    <ConfigRenderer
      schema={schema}
      hints={hints}
      values={values}
      setKeys={setKeys}
      registry={defaultRegistry}
      pluginId={plugin.id}
      onChange={handleChange}
    />
  );
}
