import {
  Select,
  SelectContent,
  SelectItem,
  SelectValue,
  SettingsControls,
  useApp,
} from "@elizaos/ui";
import { AlertTriangle, CheckCircle2 } from "lucide-react";
import type {
  AgentTab,
  LlmProvider,
  ModelOption,
} from "./coding-agent-settings-shared";

interface ModelConfigSectionProps {
  activeTab: AgentTab;
  llmProvider: LlmProvider;
  isCloud: boolean;
  prefix: string;
  powerfulValue: string;
  fastValue: string;
  modelOptions: ModelOption[];
  isDynamic: boolean;
  setPref: (key: string, value: string) => void;
}

export function ModelConfigSection({
  activeTab,
  llmProvider,
  isCloud,
  prefix,
  powerfulValue,
  fastValue,
  modelOptions,
  isDynamic,
  setPref,
}: ModelConfigSectionProps) {
  const { t } = useApp();
  return (
    <>
      <div className="flex gap-3">
        <SettingsControls.Field className="flex-1">
          <SettingsControls.FieldLabel>
            {t("codingagentsettingssection.PowerfulModel")}
          </SettingsControls.FieldLabel>
          <Select
            value={powerfulValue}
            onValueChange={(value: string) =>
              setPref(`${prefix}_MODEL_POWERFUL`, value)
            }
          >
            <SettingsControls.SelectTrigger variant="compact">
              <SelectValue
                placeholder={t("codingagentsettingssection.Default")}
              />
            </SettingsControls.SelectTrigger>
            <SelectContent>
              <SelectItem value="__default__">
                {t("codingagentsettingssection.Default")}
              </SelectItem>
              {modelOptions.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingsControls.Field>
        <SettingsControls.Field className="flex-1">
          <SettingsControls.FieldLabel>
            {t("codingagentsettingssection.FastModel")}
          </SettingsControls.FieldLabel>
          <Select
            value={fastValue}
            onValueChange={(value: string) =>
              setPref(`${prefix}_MODEL_FAST`, value)
            }
          >
            <SettingsControls.SelectTrigger variant="compact">
              <SelectValue
                placeholder={t("codingagentsettingssection.Default")}
              />
            </SettingsControls.SelectTrigger>
            <SelectContent>
              <SelectItem value="__default__">
                {t("codingagentsettingssection.Default")}
              </SelectItem>
              {modelOptions.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingsControls.Field>
      </div>

      {llmProvider === "api_keys" && (
        <SettingsControls.MutedText
          className="mt-1.5 inline-flex items-center gap-1.5"
          title={
            isDynamic
              ? t("codingagentsettingssection.ModelsFetched")
              : t("codingagentsettingssection.UsingFallback")
          }
        >
          {isDynamic ? (
            <CheckCircle2 className="h-3.5 w-3.5 text-ok" aria-hidden />
          ) : (
            <AlertTriangle className="h-3.5 w-3.5 text-warn" aria-hidden />
          )}
          <span className="sr-only">
            {isDynamic
              ? t("codingagentsettingssection.ModelsFetched")
              : t("codingagentsettingssection.UsingFallback")}
          </span>
        </SettingsControls.MutedText>
      )}
    </>
  );
}
