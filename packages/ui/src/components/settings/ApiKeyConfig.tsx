/**
 * Provider API-key / credential form for the Models & Providers settings.
 * Partitions a plugin's parameters into a Credentials group (required or
 * sensitive keys) and an Advanced disclosure, renders them through
 * ConfigRenderer, and gates saving behind OWNER role. Server-side validation
 * warnings/errors flow in as props and surface inline.
 */

import { useCallback, useMemo, useState } from "react";
import { useAgentElement } from "../../agent-surface";
import { client, type PluginParamDef } from "../../api";
import { ConfigRenderer } from "../../components/config-ui/config-renderer";
import {
  defaultRegistry,
  useConfigValidation,
} from "../../components/config-ui/config-renderer.helpers";
import { API_KEY_PREFIX_HINTS } from "../../config/api-key-prefix-hints";
import type { JsonSchemaObject } from "../../config/config-catalog";
import { useTimeout } from "../../hooks/useTimeout";
import { useAppSelector } from "../../state";
import type { ConfigUiHint } from "../../types";
import { autoLabel } from "../../utils/labels";
import { OwnerOnlyNotice, RoleGate } from "../RoleGate";
import { SettingsActionButton } from "./settings-agent-rows";
import { AdvancedSettingsDisclosure } from "./settings-control-primitives";

interface ProviderPlugin {
  id: string;
  name: string;
  parameters: PluginParamDef[];
  configured: boolean;
  configUiHints?: Record<string, ConfigUiHint>;
  enabled: boolean;
  category: string;
  /** Server-side validation against the currently-saved config. */
  validationWarnings?: Array<{ field: string; message: string }>;
  validationErrors?: Array<{ field: string; message: string }>;
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

const CREDENTIAL_KEY_PATTERN = /(KEY|TOKEN|SECRET|PASSWORD)/;

/** Splits fields into Credentials (required + sensitive) and Advanced. */
function partitionParams(params: PluginParamDef[]): {
  credentials: PluginParamDef[];
  advanced: PluginParamDef[];
} {
  const credentials: PluginParamDef[] = [];
  const advanced: PluginParamDef[] = [];
  for (const p of params) {
    const isCredential =
      p.required === true || CREDENTIAL_KEY_PATTERN.test(p.key.toUpperCase());
    if (isCredential) credentials.push(p);
    else advanced.push(p);
  }
  return { credentials, advanced };
}

function buildSchemaForParams(
  params: PluginParamDef[],
  selectedProvider: ProviderPlugin,
  pluginFieldValues: Record<string, string> | undefined,
): {
  schema: JsonSchemaObject;
  hints: Record<string, ConfigUiHint>;
  values: Record<string, unknown>;
  setKeys: Set<string>;
} {
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

    // Inline prefix validation, mirroring API_KEY_PREFIX_HINTS in
    // packages/agent/src/api/plugin-validation.ts.
    const prefixHint = API_KEY_PREFIX_HINTS[p.key];
    const fieldHint: ConfigUiHint = {
      label: autoLabel(p.key, selectedProvider.id),
      sensitive: p.sensitive ?? false,
      ...(prefixHint
        ? {
            pattern: `^${prefixHint.prefix}`,
            patternError: `${prefixHint.label} keys start with "${prefixHint.prefix}".`,
          }
        : {}),
      ...serverHints[p.key],
    };
    hints[p.key] = fieldHint;
    if (p.description && !hints[p.key].help) hints[p.key].help = p.description;
  }

  const values: Record<string, unknown> = {};
  const setKeys = new Set<string>();
  for (const p of params) {
    const cv = pluginFieldValues?.[p.key];
    if (cv !== undefined) {
      values[p.key] = cv;
    } else if (p.isSet && !p.sensitive && p.currentValue != null) {
      values[p.key] = p.currentValue;
    }
    if (p.isSet) setKeys.add(p.key);
  }

  const schema: JsonSchemaObject = {
    type: "object",
    properties,
    required,
  };
  return { schema, hints, values, setKeys };
}

async function revealSecret(
  pluginId: string,
  key: string,
): Promise<string | null> {
  try {
    const res = await fetch(
      `/api/plugins/${encodeURIComponent(pluginId)}/reveal`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key }),
      },
    );
    if (!res.ok) return null;
    const json = (await res.json()) as { value?: string | null };
    return typeof json.value === "string" ? json.value : null;
  } catch {
    return null;
  }
}

/**
 * Registers one credential field on the agent surface so chat can read and set
 * it ("set my OpenRouter key to …"). The {@link ConfigRenderer} owns the visible
 * input; this binds value/fill to the same `pluginFieldValues` state.
 */
function CredentialFieldAgentBinding({
  agentId,
  label,
  getValue,
  onFill,
}: {
  agentId: string;
  label: string;
  getValue: () => string;
  onFill: (value: string) => void;
}) {
  const { ref, agentProps } = useAgentElement<HTMLSpanElement>({
    id: agentId,
    role: "text-input",
    label,
    group: "apikey-credentials",
    getValue,
    onFill,
  });
  return <span ref={ref} hidden aria-hidden {...agentProps} />;
}

/**
 * Provider API keys are OWNER-tier credentials (#12087 Item 24): only the
 * workspace owner may view or set them. Gated at the surface boundary via the
 * canonical {@link RoleGate}.
 */
export function ApiKeyConfig(props: ApiKeyConfigProps) {
  return (
    <RoleGate minRole="OWNER" fallback={<OwnerOnlyNotice />}>
      <ApiKeyConfigBody {...props} />
    </RoleGate>
  );
}

function ApiKeyConfigBody({
  selectedProvider,
  pluginSaving,
  pluginSaveSuccess,
  handlePluginConfigSave,
  loadPlugins,
}: ApiKeyConfigProps) {
  const { setTimeout } = useTimeout();
  const { configRef, validateAll } = useConfigValidation();

  const t = useAppSelector((s) => s.t);
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
      if (!validateAll()) return;
      const values = pluginFieldValues[pluginId] ?? {};
      void handlePluginConfigSave(pluginId, values);
    },
    [pluginFieldValues, handlePluginConfigSave, validateAll],
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
            message: err instanceof Error ? err.message : t("common.failed"),
          }),
        });
        setTimeout(() => setModelsFetchResult(null), 5000);
      }
      setModelsFetching(false);
    },
    [loadPlugins, setTimeout, t],
  );

  const partitions = useMemo(
    () =>
      selectedProvider
        ? partitionParams(selectedProvider.parameters)
        : { credentials: [], advanced: [] },
    [selectedProvider],
  );

  const credentialsForm = useMemo(
    () =>
      selectedProvider
        ? buildSchemaForParams(
            partitions.credentials,
            selectedProvider,
            pluginFieldValues[selectedProvider.id],
          )
        : null,
    [partitions.credentials, pluginFieldValues, selectedProvider],
  );

  const advancedForm = useMemo(
    () =>
      selectedProvider && partitions.advanced.length > 0
        ? buildSchemaForParams(
            partitions.advanced,
            selectedProvider,
            pluginFieldValues[selectedProvider.id],
          )
        : null,
    [partitions.advanced, pluginFieldValues, selectedProvider],
  );

  if (!selectedProvider || selectedProvider.parameters.length === 0)
    return null;

  const isSaving = pluginSaving.has(selectedProvider.id);
  const saveSuccess = pluginSaveSuccess.has(selectedProvider.id);
  const configured = selectedProvider.configured;

  return (
    <div className="border-t border-border/40 pt-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="text-xs font-semibold text-txt">
          {selectedProvider.name}
        </h3>
        <span
          className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium ${
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

      {/* Server-side validation against the already-saved config. */}
      {(selectedProvider.validationErrors?.length ||
        selectedProvider.validationWarnings?.length) && (
        <div className="mb-3 space-y-1.5">
          {selectedProvider.validationErrors?.map((issue, i) => (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: stable per-render order
              key={`err-${i}`}
              role="alert"
              className="rounded-sm border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger"
            >
              <span className="font-semibold">{issue.field}</span> —{" "}
              {issue.message}
            </div>
          ))}
          {selectedProvider.validationWarnings?.map((issue, i) => (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: stable per-render order
              key={`warn-${i}`}
              role="status"
              className="rounded-sm border border-warn/40 bg-warn/10 px-3 py-2 text-xs text-warn"
            >
              <span className="font-semibold">{issue.field}</span> —{" "}
              {issue.message}
            </div>
          ))}
        </div>
      )}

      {credentialsForm && partitions.credentials.length > 0 ? (
        <>
          <ConfigRenderer
            ref={configRef}
            schema={credentialsForm.schema}
            hints={credentialsForm.hints}
            values={credentialsForm.values}
            setKeys={credentialsForm.setKeys}
            registry={defaultRegistry}
            pluginId={selectedProvider.id}
            onChange={(key, value) =>
              handlePluginFieldChange(
                selectedProvider.id,
                key,
                String(value ?? ""),
              )
            }
            revealSecret={revealSecret}
          />
          {partitions.credentials.map((param) => (
            <CredentialFieldAgentBinding
              key={param.key}
              agentId={`apikey-${selectedProvider.id}-${param.key}`}
              label={credentialsForm.hints[param.key]?.label ?? param.key}
              getValue={() =>
                pluginFieldValues[selectedProvider.id]?.[param.key] ??
                String(credentialsForm.values[param.key] ?? "")
              }
              onFill={(value) =>
                handlePluginFieldChange(selectedProvider.id, param.key, value)
              }
            />
          ))}
        </>
      ) : null}

      {advancedForm ? (
        <AdvancedSettingsDisclosure title="Advanced" className="mt-4">
          <ConfigRenderer
            schema={advancedForm.schema}
            hints={advancedForm.hints}
            values={advancedForm.values}
            setKeys={advancedForm.setKeys}
            registry={defaultRegistry}
            pluginId={selectedProvider.id}
            onChange={(key, value) =>
              handlePluginFieldChange(
                selectedProvider.id,
                key,
                String(value ?? ""),
              )
            }
            revealSecret={revealSecret}
          />
        </AdvancedSettingsDisclosure>
      ) : null}

      <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-2">
          <SettingsActionButton
            agentId={`apikey-fetch-models-${selectedProvider.id}`}
            agentLabel={t("apikeyconfig.fetchModels")}
            variant="outline"
            size="sm"
            className="h-9 rounded-sm"
            onClick={() => void handleFetchModels(selectedProvider.id)}
            disabled={modelsFetching}
          >
            {modelsFetching
              ? t("apikeyconfig.fetching")
              : t("apikeyconfig.fetchModels")}
          </SettingsActionButton>
          {modelsFetchResult && (
            <span
              aria-live="polite"
              className={`truncate text-xs ${
                modelsFetchResult.tone === "error" ? "text-danger" : "text-ok"
              }`}
            >
              {modelsFetchResult.message}
            </span>
          )}
        </div>
        <SettingsActionButton
          agentId={`apikey-save-${selectedProvider.id}`}
          agentLabel={t("common.save")}
          agentStatus={isSaving ? "saving" : saveSuccess ? "saved" : undefined}
          variant="default"
          size="sm"
          className="h-11 w-full rounded-md font-semibold sm:h-9 sm:w-auto"
          onClick={() => handlePluginSave(selectedProvider.id)}
          disabled={isSaving}
        >
          {isSaving
            ? t("common.saving")
            : saveSuccess
              ? t("common.saved")
              : t("common.save")}
        </SettingsActionButton>
      </div>
    </div>
  );
}
