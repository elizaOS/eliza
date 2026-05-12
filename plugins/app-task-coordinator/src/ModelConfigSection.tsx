import { useApp } from "@elizaos/ui";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectValue,
  SettingsControls,
} from "@elizaos/ui";
import { AlertTriangle, CheckCircle2 } from "lucide-react";
import type {
  AgentTab,
  AiderProvider,
  LlmProvider,
  ModelOption,
} from "./coding-agent-settings-shared";

interface ModelConfigSectionProps {
  activeTab: AgentTab;
  llmProvider: LlmProvider;
  isCloud: boolean;
  aiderProvider: AiderProvider;
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
  aiderProvider,
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
      {activeTab === "aider" && (
        <SettingsControls.Field>
          <SettingsControls.FieldLabel>
            {t("codingagentsettingssection.Provider")}
          </SettingsControls.FieldLabel>
          <Select
            value={aiderProvider}
            onValueChange={(value: string) =>
              setPref("PARALLAX_AIDER_PROVIDER", value)
            }
          >
            <SettingsControls.SelectTrigger variant="compact">
              <SelectValue />
            </SettingsControls.SelectTrigger>
            <SelectContent>
              <SelectItem value="anthropic">
                {t("codingagentsettingssection.Anthropic")}
              </SelectItem>
              <SelectItem value="openai">
                {t("codingagentsettingssection.OpenAI")}
              </SelectItem>
              {!isCloud && (
                <SelectItem value="google">
                  {t("codingagentsettingssection.Google")}
                </SelectItem>
              )}
            </SelectContent>
          </Select>
        </SettingsControls.Field>
      )}

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

      {llmProvider === "api_keys" && activeTab !== "aider" && (
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
