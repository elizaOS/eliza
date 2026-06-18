import type { ModelOption } from "@elizaos/shared";
import { CheckCircle2, Loader2 } from "lucide-react";
import { ConfigRenderer } from "../../components/config-ui/config-renderer";
import { defaultRegistry } from "../../components/config-ui/config-renderer.helpers";
import { appNameInterpolationVars, useBranding } from "../../config/branding";
import { useApp } from "../../state";
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
  const { t } = useApp();
  const branding = useBranding();

  const hasModelControls =
    elizaCloudConnected &&
    (largeModelOptions.length > 0 || cloudModelSchema !== null);

  if (!showCloudControls || !hasModelControls) return null;

  return (
    <div className="border-border border-t">
      {largeModelOptions.length > 0 ? (
        <SettingsSelectRow
          agentId="routing-primary-model"
          label={t("providerswitcher.model", {
            defaultValue: "Primary model",
          })}
          description={t("providerswitcher.modelDesc", {
            defaultValue: "The model used for the agent's main reasoning.",
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
      <div className="px-4 py-4">
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
        <div className="mt-3 flex flex-col items-start justify-between gap-2 sm:flex-row sm:items-center">
          <p className="text-muted text-xs-tight">
            {t(
              "providerswitcher.restartRequiredHint",
              appNameInterpolationVars(branding),
            )}
          </p>
          <div className="flex items-center gap-2">
            {modelSaving && (
              <span
                className="inline-flex items-center text-muted"
                title={t("providerswitcher.savingRestarting")}
                role="status"
                aria-label={t("providerswitcher.savingRestarting")}
              >
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              </span>
            )}
            {modelSaveSuccess && (
              <span
                className="inline-flex items-center text-ok"
                title={t("providerswitcher.savedRestartingAgent")}
                role="status"
                aria-label={t("providerswitcher.savedRestartingAgent")}
              >
                <CheckCircle2 className="h-3.5 w-3.5" />
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
