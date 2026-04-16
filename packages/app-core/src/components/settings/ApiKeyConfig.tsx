
import { useCallback, useState } from "react";
import { client, type PluginParamDef } from "../../api";
import {
  ConfigRenderer,
  defaultRegistry,
  type JsonSchemaObject,
} from "../../config";
import { useTimeout } from "@elizaos/ui";
import { useApp } from "../../state";
import type { ConfigUiHint } from "../../types";
import { autoLabel } from "../../utils/labels";
import { Button } from "@elizaos/ui";

interface ProviderPlugin {
  id: string;
  name: string;
  parameters: PluginParamDef[];
  configured: boolean;
  configUiHints?: Record<string, ConfigUiHint>;
  enabled: boolean;
  category: string;
}

export interface ApiKeyConfigProps {
  selectedProvider: ProviderPlugin | null;
  pluginSaving: Set<string>;
  pluginSaveSuccess: Set<string>;
  handlePluginConfigSave: (
    pluginId: string,
    values: Record<string, string>,
  ) => void;
  loadPlugins: () => Promise<void>;
}

export function ApiKeyConfig({
  selectedProvider,
  pluginSaving,
  pluginSaveSuccess,
  handlePluginConfigSave,
  loadPlugins,
}: ApiKeyConfigProps) {
  const { setTimeout } = useTimeout();

  const { t } = useApp();
  const [pluginFieldValues, setPluginFieldValues] = useState<
    Record<string, Record<string, string>>
  >({});
  const [modelsFetching, setModelsFetching] = useState(false);
  const [modelsFetchResult, setModelsFetchResult] = useState<{
    tone: "error" | "success";
    message: string;
  } | null>(null);

  const handlePluginFieldChange = useCallback(
    (pluginId: string, key: string, value: string) => {
      setPluginFieldValues((prev) => ({
        ...prev,
        [pluginId]: { ...(prev[pluginId] ?? {}), [key]: value },
      }));
    },
    [],
  );

  const handlePluginSave = useCallback(
    (pluginId: string) => {
      const values = pluginFieldValues[pluginId] ?? {};
      void handlePluginConfigSave(pluginId, values);
    },
    [pluginFieldValues, handlePluginConfigSave],
  );

  const handleFetchModels = useCallback(
    async (providerId: string) => {
      setModelsFetching(true);
      setModelsFetchResult(null);
      try {
        const result = await client.fetchModels(providerId, true);
        const count = Array.isArray(result?.models) ? result.models.length : 0;
        setModelsFetchResult({
          tone: "success",
          message: t("apikeyconfig.loadedModels", { count }),
        });
        await loadPlugins();
        setTimeout(() => setModelsFetchResult(null), 3000);
      } catch (err) {
        setModelsFetchResult({
          tone: "error",
          message: t("apikeyconfig.error", {
            message:
              err instanceof Error ? err.message : t("apikeyconfig.failed"),
          }),
        });
        setTimeout(() => setModelsFetchResult(null), 5000);
      }
      setModelsFetching(false);
    },
    [loadPlugins, setTimeout, t],
  );

  if (!selectedProvider || selectedProvider.parameters.length === 0)
    return null;

  const isSaving = pluginSaving.has(selectedProvider.id);
  const saveSuccess = pluginSaveSuccess.has(selectedProvider.id);
  const params = selectedProvider.parameters;
  const setCount = params.filter((p: PluginParamDef) => p.isSet).length;

  const properties: Record<string, Record<string, unknown>> = {};
  const required: string[] = [];
  const hints: Record<string, ConfigUiHint> = {};
  const serverHints = selectedProvider.configUiHints ?? {};
  for (const p of params) {
    const prop: Record<string, unknown> = {};
    if (p.type === "boolean") prop.type = "boolean";
    else if (p.type === "number") prop.type = "number";
    else prop.type = "string";
    if (p.description) prop.description = p.description;
    if (p.default != null) prop.default = p.default;
    if (p.options?.length) prop.enum = p.options;
    const k = p.key.toUpperCase();
    if (k.includes("URL") || k.includes("ENDPOINT")) prop.format = "uri";
    properties[p.key] = prop;
    if (p.required) required.push(p.key);
    hints[p.key] = {
      label: autoLabel(p.key, selectedProvider.id),
      sensitive: p.sensitive ?? false,
      ...serverHints[p.key],
    };
    if (p.description && !hints[p.key].help) hints[p.key].help = p.description;
  }
  const schema = { type: "object", properties, required } as JsonSchemaObject;
  const values: Record<string, unknown> = {};
  const setKeys = new Set<string>();
  for (const p of params) {
    const cv = pluginFieldValues[selectedProvider.id]?.[p.key];
    if (cv !== undefined) {
      values[p.key] = cv;
    } else if (p.isSet && !p.sensitive && p.currentValue != null) {
      values[p.key] = p.currentValue;
    }
    if (p.isSet) setKeys.add(p.key);
  }

  return (
    <div className="mt-4 pt-4">
      <div className="flex justify-between items-center mb-3">
        <div className="text-xs font-semibold">
          {selectedProvider.name} {t("nav.settings")}
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs-tight text-muted">
            {setCount}/{params.length} {t("apikeyconfig.configured")}
          </span>
          <span
            className="text-xs-tight px-2 py-[3px] border"
            style={{
              borderColor: selectedProvider.configured
                ? "var(--ok)"
                : "var(--warn)",
              color: selectedProvider.configured ? "var(--ok)" : "var(--warn)",
            }}
          >
            {selectedProvider.configured
              ? t("config-field.Configured")
              : t("mediasettingssection.NeedsSetup")}
          </span>
        </div>
      </div>

      <ConfigRenderer
        schema={schema}
        hints={hints}
        values={values}
        setKeys={setKeys}
        registry={defaultRegistry}
        pluginId={selectedProvider.id}
        onChange={(key, value) =>
          handlePluginFieldChange(selectedProvider.id, key, String(value ?? ""))
        }
      />

      <div className="flex justify-between items-center mt-3">
        <div className="flex items-center gap-2 min-h-8">
          <Button
            variant="outline"
            size="sm"
            onClick={() => void handleFetchModels(selectedProvider.id)}
            disabled={modelsFetching}
          >
            {modelsFetching
              ? t("apikeyconfig.fetching")
              : t("apikeyconfig.fetchModels")}
          </Button>
          <span
            className={`text-xs-tight min-h-4 flex items-center max-w-[min(100%,16rem)] ${
              modelsFetchResult
                ? modelsFetchResult.tone === "error"
                  ? "text-danger"
                  : "text-ok"
                : "text-transparent select-none"
            }`}
            aria-live="polite"
          >
            {modelsFetchResult?.message ?? "\u00a0"}
          </span>
        </div>
        <Button
          variant="default"
          size="sm"
          onClick={() => handlePluginSave(selectedProvider.id)}
          disabled={isSaving}
          className={saveSuccess ? "bg-ok border-ok" : ""}
        >
          {isSaving
            ? t("apikeyconfig.saving")
            : saveSuccess
              ? t("apikeyconfig.saved")
              : t("apikeyconfig.save")}
        </Button>
      </div>
    </div>
  );
}
