/**
 * Presentational Eliza Cloud model-routing panel for ProviderSwitcher: a primary
 * large-tier model dropdown plus an "Model overrides" disclosure that renders
 * the per-tier ConfigRenderer schema. All state (options, values, save status)
 * is controlled by the parent via `useCloudModelConfig`.
 */

import type { ModelOption } from "@elizaos/shared";
import { CheckCircle2, Loader2 } from "lucide-react";
import { ConfigRenderer } from "../../components/config-ui/config-renderer";
import { defaultRegistry } from "../../components/config-ui/config-renderer.helpers";
import { useAppSelector } from "../../state";
import type { CloudModelSchema } from "./cloud-model-schema";
import { SettingsSelectRow } from "./settings-agent-rows";
import { AdvancedSettingsDisclosure } from "./settings-control-primitives";

export interface ProviderRoutingPanelProps {
  /** All cloud large-tier models, used for the visible primary dropdown. */
  largeModelOptions: ModelOption[];
  /** Full cloud tier schema (nano/small/medium/large/mega + overrides). */
  cloudModelSchema: CloudModelSchema | null;
  /** Current model values keyed by tier id. */
  modelValues: {
    values: Record<string, unknown>;
    setKeys: Set<string>;
  };
  currentLargeModel: string;
  modelSaving: boolean;
  modelSaveSuccess: boolean;
  onModelFieldChange: (key: string, value: unknown) => void;
  /** Show the cloud model-overrides UI only when cloud is the active route. */
  showCloudControls: boolean;
  elizaCloudConnected: boolean;
}

export function ProviderRoutingPanel({
  largeModelOptions,
  cloudModelSchema,
  modelValues,
  currentLargeModel,
  modelSaving,
  modelSaveSuccess,
  onModelFieldChange,
  showCloudControls,
  elizaCloudConnected,
}: ProviderRoutingPanelProps) {
  const t = useAppSelector((s) => s.t);

  const hasModelControls =
    elizaCloudConnected &&
    (largeModelOptions.length > 0 || cloudModelSchema !== null);

  if (!showCloudControls || !hasModelControls) return null;

  return (
    <div className="flex flex-col">
      {largeModelOptions.length > 0 ? (
        <SettingsSelectRow
          agentId="routing-primary-model"
          label={t("providerswitcher.model", {
            defaultValue: "Primary model",
          })}
          value={currentLargeModel || ""}
          onValueChange={(v) => onModelFieldChange("large", v)}
          placeholder={t("providerswitcher.chooseModel", {
            defaultValue: "Choose a model",
          })}
          options={largeModelOptions.map((model) => ({
            value: model.id,
            label: model.name,
          }))}
          triggerClassName="w-full"
        />
      ) : null}
      {cloudModelSchema ? (
        <AdvancedSettingsDisclosure title="Model overrides">
          <ConfigRenderer
            schema={cloudModelSchema.schema}
            hints={cloudModelSchema.hints}
            values={modelValues.values}
            setKeys={modelValues.setKeys}
            registry={defaultRegistry}
            onChange={onModelFieldChange}
          />
        </AdvancedSettingsDisclosure>
      ) : null}
      {modelSaving ? (
        <span
          className="inline-flex items-center py-2 text-muted"
          title={t("providerswitcher.savingRestarting")}
          role="status"
          aria-label={t("providerswitcher.savingRestarting")}
        >
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        </span>
      ) : null}
      {modelSaveSuccess ? (
        <span
          className="inline-flex items-center py-2 text-ok"
          title={t("providerswitcher.savedRestartingAgent")}
          role="status"
          aria-label={t("providerswitcher.savedRestartingAgent")}
        >
          <CheckCircle2 className="h-3.5 w-3.5" />
        </span>
      ) : null}
    </div>
  );
}
