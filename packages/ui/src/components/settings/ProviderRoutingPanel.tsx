import type { ModelOption } from "@elizaos/shared";
import { CheckCircle2, Loader2 } from "lucide-react";
import { ConfigRenderer } from "../../components/config-ui/config-renderer";
import { defaultRegistry } from "../../components/config-ui/config-renderer.helpers";
import { appNameInterpolationVars, useBranding } from "../../config/branding";
import { useApp } from "../../state";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import type { CloudModelSchema } from "./cloud-model-schema";
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
    <div className="border-border/40 border-t px-3 py-4 sm:px-5">
      {largeModelOptions.length > 0 ? (
        <div>
          <label
            htmlFor="provider-switcher-primary-model"
            className="mb-1.5 block text-muted text-xs font-medium uppercase tracking-wider"
          >
            {t("providerswitcher.model", { defaultValue: "Model" })}
          </label>
          <Select
            value={currentLargeModel || ""}
            onValueChange={(v) => onModelFieldChange("large", v)}
          >
            <SelectTrigger
              id="provider-switcher-primary-model"
              className="h-9 w-full rounded-sm border border-border bg-card text-sm sm:max-w-sm"
            >
              <SelectValue
                placeholder={t("providerswitcher.chooseModel", {
                  defaultValue: "Choose a model",
                })}
              />
            </SelectTrigger>
            <SelectContent className="max-h-64">
              {largeModelOptions.map((model) => (
                <SelectItem key={model.id} value={model.id}>
                  {model.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ) : null}
      {cloudModelSchema ? (
        <AdvancedSettingsDisclosure title="Model overrides" className="mt-4">
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
      <div className="mt-2 flex flex-col items-start justify-between gap-2 sm:flex-row sm:items-center">
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
  );
}
