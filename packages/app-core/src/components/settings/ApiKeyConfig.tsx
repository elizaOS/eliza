/**
 * Per-provider env / API key fields under **AI Model**.
 *
 * WHY visibility is controlled upstream: `ProviderSwitcher` hides this while `providerSelectLocked`
 * so Radix `Select` and dense inputs are not both active during `switchProvider` + `loadPlugins`
 * (see `ProviderSwitcher.tsx` file header).
 */
import { Button, Input, useTimeout } from "@elizaos/ui";
import { useCallback, useState } from "react";
import { client, type PluginParamDef } from "../../api";
import {
  ConfigRenderer,
  defaultRegistry,
  type JsonSchemaObject,
} from "../../config";
import {
  formatOnboardingPluginProviderLabel,
  getOnboardingProviderOption,
} from "../../providers";
import { useApp } from "../../state";
import type { ConfigUiHint } from "../../types";
import { autoLabel } from "../../utils/labels";

function normalizeAiProviderPluginId(value: string): string {
  return value
    .toLowerCase()
    .replace(/^@[^/]+\//, "")
    .replace(/^plugin-/, "");
}

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
  /**
   * For catalog-backed providers that are not yet present in the plugin list
   * (no parameter schema). Persists the key via `switchProvider` + restart.
   */
  onSaveCatalogApiKey?: (
    onboardingProviderId: string,
    apiKey: string,
  ) => Promise<void>;
}

export function ApiKeyConfig({
  selectedProvider,
  pluginSaving,
  pluginSaveSuccess,
  handlePluginConfigSave,
  loadPlugins,
  onSaveCatalogApiKey,
}: ApiKeyConfigProps) {
  const { setTimeout } = useTimeout();

  const { t, setActionNotice } = useApp();
  const [catalogApiKeyDraft, setCatalogApiKeyDraft] = useState("");
  const [catalogKeySaving, setCatalogKeySaving] = useState(false);
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

  if (!selectedProvider) return null;

  const onboardingProviderId =
    getOnboardingProviderOption(
      normalizeAiProviderPluginId(selectedProvider.id),
    )?.id ?? normalizeAiProviderPluginId(selectedProvider.id);
  const catalogOption = getOnboardingProviderOption(onboardingProviderId);

  if (selectedProvider.parameters.length === 0) {
    if (typeof onSaveCatalogApiKey !== "function") {
      return null;
    }
    if (catalogOption?.envKey) {
      const isSaving = catalogKeySaving;
      return (
        <div className="border-t border-border/40 pt-6">
          <div className="mb-3 flex items-center justify-between gap-2">
            <h3 className="text-xs font-semibold text-txt">
              {formatOnboardingPluginProviderLabel(
                selectedProvider.id,
                selectedProvider.name,
                t,
              )}
            </h3>
          </div>
          <p className="mb-3 text-xs text-muted-foreground">
            {t("apikeyconfig.catalogDirectKeyHelp")}
          </p>
          <div className="space-y-2">
            <label
              className="block text-xs font-medium text-foreground"
              htmlFor="catalog-direct-api-key"
            >
              {catalogOption.envKey}
            </label>
            <Input
              id="catalog-direct-api-key"
              type="password"
              autoComplete="off"
              className="h-9 w-full max-w-md rounded-lg border border-input bg-background text-sm"
              value={catalogApiKeyDraft}
              onChange={(e) => setCatalogApiKeyDraft(e.target.value)}
              placeholder={t("apikeyconfig.apiKeyPlaceholder")}
            />
          </div>
          <div className="mt-6 flex justify-end">
            <Button
              variant="default"
              size="sm"
              className="h-9 rounded-lg font-semibold"
              disabled={isSaving || !catalogApiKeyDraft.trim()}
              onClick={() => {
                const key = catalogApiKeyDraft.trim();
                if (!key) return;
                setCatalogKeySaving(true);
                void (async () => {
                  try {
                    await onSaveCatalogApiKey(String(catalogOption.id), key);
                    setCatalogApiKeyDraft("");
                    setActionNotice?.(
                      t("apikeyconfig.catalogKeyActivated"),
                      "success",
                      4000,
                    );
                  } catch (err) {
                    setActionNotice?.(
                      t("apikeyconfig.error", {
                        message:
                          err instanceof Error
                            ? err.message
                            : t("apikeyconfig.failed"),
                      }),
                      "error",
                      5000,
                    );
                  } finally {
                    setCatalogKeySaving(false);
                  }
                })();
              }}
            >
              {isSaving
                ? t("apikeyconfig.saving")
                : t("apikeyconfig.saveAndActivate")}
            </Button>
          </div>
        </div>
      );
    }
    if (catalogOption) {
      return (
        <div className="border-t border-border/40 pt-6">
          <h3 className="mb-2 text-xs font-semibold text-txt">
            {formatOnboardingPluginProviderLabel(
              selectedProvider.id,
              selectedProvider.name,
              t,
            )}
          </h3>
          <p className="text-xs text-muted-foreground">
            {catalogOption.description}
          </p>
        </div>
      );
    }
    return null;
  }

  const isSaving = pluginSaving.has(selectedProvider.id);
  const saveSuccess = pluginSaveSuccess.has(selectedProvider.id);
  const params = selectedProvider.parameters;
  const configured = selectedProvider.configured;

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
    <div className="border-t border-border/40 pt-6">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="text-xs font-semibold text-txt">
          {selectedProvider.name}
        </h3>
        <span
          className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-2xs font-medium ${
            configured
              ? "border-ok/30 bg-ok/10 text-ok"
              : "border-warn/30 bg-warn/10 text-warn"
          }`}
        >
          <span
            className={`h-1.5 w-1.5 rounded-full ${configured ? "bg-ok" : "bg-warn"}`}
          />
          {configured
            ? t("config-field.Configured")
            : t("mediasettingssection.NeedsSetup")}
        </span>
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

      <div className="mt-6 flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            className="h-9 rounded-lg"
            onClick={() => void handleFetchModels(selectedProvider.id)}
            disabled={modelsFetching}
          >
            {modelsFetching
              ? t("apikeyconfig.fetching")
              : t("apikeyconfig.fetchModels")}
          </Button>
          {modelsFetchResult && (
            <span
              aria-live="polite"
              className={`truncate text-xs-tight ${
                modelsFetchResult.tone === "error" ? "text-danger" : "text-ok"
              }`}
            >
              {modelsFetchResult.message}
            </span>
          )}
        </div>
        <Button
          variant="default"
          size="sm"
          className="h-9 rounded-lg font-semibold"
          onClick={() => handlePluginSave(selectedProvider.id)}
          disabled={isSaving}
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
