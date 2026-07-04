/**
 * Renders a plugin's configurable parameters as a form, inside the expanded
 * settings section of a `PluginCard`. Derives a config schema from the plugin's
 * declared parameters, merges server-provided `configUiHints` over the
 * auto-generated ones (server wins), and drives the shared `ConfigRenderer`.
 * Value changes flow back out through `onParamChange`.
 */
import { useCallback, useMemo, useRef, useState } from "react";
import type { PluginInfo, PluginParamDef } from "../../api";
import { ConfigRenderer } from "../../components/config-ui/config-renderer";
import { defaultRegistry } from "../../components/config-ui/config-renderer.helpers";
import type { ConfigUiHint } from "../../types";
import { Switch } from "../ui/switch";
import { paramsToSchema } from "./plugin-list-utils";

type ModeToggleHint = NonNullable<ConfigUiHint["modeToggle"]>;

function isModeToggleHint(
  hint: ConfigUiHint | undefined,
): hint is ConfigUiHint & { modeToggle: ModeToggleHint } {
  return hint?.modeToggle?.kind === "mode-toggle-with-hidden-field";
}

function hiddenModeValue(toggle: ModeToggleHint): string {
  return toggle.hiddenValue ?? "";
}

function isHiddenMode(value: string, toggle: ModeToggleHint): boolean {
  return value.trim() === hiddenModeValue(toggle).trim();
}

function ModeToggleWithHiddenField({
  checked,
  hint,
  onToggle,
}: {
  checked: boolean;
  hint: ConfigUiHint & { modeToggle: ModeToggleHint };
  onToggle: (next: boolean) => void;
}) {
  const toggle = hint.modeToggle;
  return (
    <div className="flex items-center justify-between rounded-sm border border-border bg-[var(--card,rgba(255,255,255,0.03))] px-4 py-3 mb-4">
      <div className="flex flex-col gap-0.5">
        <span className="text-sm font-semibold text-txt">
          {checked ? toggle.enabledLabel : toggle.disabledLabel}
        </span>
        {(checked ? toggle.enabledHelp : toggle.disabledHelp) && (
          <span className="text-xs-tight text-muted">
            {checked ? toggle.enabledHelp : toggle.disabledHelp}
          </span>
        )}
      </div>
      <Switch checked={checked} onCheckedChange={onToggle} />
    </div>
  );
}

/* ── PluginConfigForm bridge ─────────────────────────────────────────── */

export function PluginConfigForm({
  plugin,
  pluginConfigs,
  onParamChange,
}: {
  plugin: PluginInfo;
  pluginConfigs: Record<string, Record<string, string>>;
  onParamChange: (pluginId: string, paramKey: string, value: string) => void;
}) {
  const params = plugin.parameters ?? [];
  const { schema, hints: autoHints } = useMemo(
    () => paramsToSchema(params, plugin.id),
    [params, plugin.id],
  );

  // Merge server-provided configUiHints over auto-generated hints.
  // Server hints take priority (override auto-generated ones).
  const baseHints = useMemo(() => {
    const merged: Record<string, ConfigUiHint> = { ...autoHints };
    const serverHints = plugin.configUiHints;
    if (serverHints) {
      for (const [key, serverHint] of Object.entries(serverHints)) {
        merged[key] = { ...merged[key], ...serverHint };
      }
    }
    return merged;
  }, [autoHints, plugin.configUiHints]);

  const getCurrentValue = useCallback(
    (param: PluginParamDef): string => {
      const configValue = pluginConfigs[plugin.id]?.[param.key];
      if (configValue !== undefined) return configValue;
      return param.currentValue != null ? String(param.currentValue) : "";
    },
    [plugin.id, pluginConfigs],
  );

  const modeToggleFields = useMemo(
    () =>
      params
        .map((param) => {
          const hint = baseHints[param.key];
          if (!isModeToggleHint(hint)) return null;
          return {
            key: param.key,
            hint,
            currentValue: getCurrentValue(param),
          };
        })
        .filter(
          (
            field,
          ): field is {
            key: string;
            hint: ConfigUiHint & { modeToggle: ModeToggleHint };
            currentValue: string;
          } => field !== null,
        ),
    [baseHints, getCurrentValue, params],
  );

  const [modeToggleOverrides, setModeToggleOverrides] = useState<
    Record<string, boolean>
  >({});
  const stashedModeToggleValues = useRef<Record<string, string>>({});

  const modeToggleControls = useMemo(
    () =>
      modeToggleFields.map((field) => {
        const checked =
          modeToggleOverrides[field.key] ??
          isHiddenMode(field.currentValue, field.hint.modeToggle);
        if (!isHiddenMode(field.currentValue, field.hint.modeToggle)) {
          stashedModeToggleValues.current[field.key] = field.currentValue;
        }
        return { ...field, checked };
      }),
    [modeToggleFields, modeToggleOverrides],
  );

  const hints = useMemo(() => {
    const merged: Record<string, ConfigUiHint> = { ...baseHints };
    for (const control of modeToggleControls) {
      if (control.checked) {
        merged[control.key] = { ...merged[control.key], hidden: true };
      }
    }
    return merged;
  }, [baseHints, modeToggleControls]);

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

  const handleModeToggle = useCallback(
    (key: string, hint: ModeToggleHint, next: boolean) => {
      setModeToggleOverrides((current) => ({ ...current, [key]: next }));
      if (next) {
        onParamChange(plugin.id, key, hiddenModeValue(hint));
        return;
      }
      const restore =
        stashedModeToggleValues.current[key]?.trim() || hint.restoreValue || "";
      onParamChange(plugin.id, key, restore);
    },
    [onParamChange, plugin.id],
  );

  return (
    <>
      {modeToggleControls.map((control) => (
        <ModeToggleWithHiddenField
          key={control.key}
          checked={control.checked}
          hint={control.hint}
          onToggle={(next) =>
            handleModeToggle(control.key, control.hint.modeToggle, next)
          }
        />
      ))}
      <ConfigRenderer
        schema={schema}
        hints={hints}
        values={values}
        setKeys={setKeys}
        registry={defaultRegistry}
        pluginId={plugin.id}
        onChange={handleChange}
      />
    </>
  );
}
