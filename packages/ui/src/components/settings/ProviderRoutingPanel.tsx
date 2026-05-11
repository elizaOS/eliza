import {
  Checkbox,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  TooltipHint,
} from "@elizaos/ui";
import { CheckCircle2, Loader2 } from "lucide-react";
import type { OnboardingOptions } from "../../api";
import {
  ConfigRenderer,
  defaultRegistry,
} from "../../components/config-ui/config-renderer";
import { appNameInterpolationVars, useBranding } from "../../config/branding";
import { useApp } from "../../state";
import type { CloudModelSchema } from "./cloud-model-schema";
import { AdvancedSettingsDisclosure } from "./settings-control-primitives";

const LOCAL_EMBEDDINGS_TOOLTIP =
  "Embeddings are vector representations of your messages, used for memory and search. Keeping them local means your message text isn't sent to the cloud just to compute vectors. Chat still goes through the cloud.";

export interface ProviderRoutingPanelProps {
  /** All cloud large-tier models, used for the visible primary dropdown. */
  largeModelOptions: OnboardingOptions["models"]["large"];
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
  localEmbeddings: boolean;
  onToggleLocalEmbeddings: (next: boolean) => void;
  /** Show the local-embeddings + model-overrides UI only when cloud is the active route. */
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
  localEmbeddings,
  onToggleLocalEmbeddings,
  showCloudControls,
  elizaCloudConnected,
}: ProviderRoutingPanelProps) {
  const { t } = useApp();
  const branding = useBranding();

  const hasModelControls =
    elizaCloudConnected &&
    (largeModelOptions.length > 0 || cloudModelSchema !== null);

  if (!showCloudControls) return null;

  return (
    <>
      <div className="border-border/40 border-t px-3 py-3 sm:px-5">
        <LocalEmbeddingsCheckbox
          checked={localEmbeddings}
          onCheckedChange={onToggleLocalEmbeddings}
        />
      </div>
      {hasModelControls ? (
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
                  className="h-9 w-full rounded-lg border border-border bg-card text-sm sm:max-w-sm"
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
            <AdvancedSettingsDisclosure
              title="Model overrides"
              className="mt-4"
            >
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
      ) : null}
    </>
  );
}

function LocalEmbeddingsCheckbox({
  checked,
  onCheckedChange,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex items-start gap-2.5 py-1">
      <Checkbox
        id="provider-switcher-local-embeddings"
        checked={checked}
        onCheckedChange={(value) => onCheckedChange(value === true)}
        className="mt-0.5 shrink-0"
        aria-label="Use local embeddings"
      />
      <div className="flex min-w-0 items-center gap-1.5">
        <label
          htmlFor="provider-switcher-local-embeddings"
          className="cursor-pointer text-xs-tight text-txt select-none"
        >
          Use local embeddings
        </label>
        <TooltipHint content={LOCAL_EMBEDDINGS_TOOLTIP} side="top">
          <span
            className="inline-flex h-4 w-4 shrink-0 cursor-help items-center justify-center rounded-full border border-border/40 text-2xs text-muted hover:text-txt"
            aria-hidden="true"
          >
            ?
          </span>
        </TooltipHint>
      </div>
    </div>
  );
}
