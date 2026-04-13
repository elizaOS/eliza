/**
 * Per-agent model configuration: Aider provider selector (when the
 * active tab is Aider) plus Powerful / Fast model selects and the
 * fallback-vs-dynamic-models hint line.
 *
 * Extracted from `CodingAgentSettingsSection.tsx` to keep that file
 * under the project's ~500 LOC guideline.
 */

import {
  Select,
  SelectContent,
  SelectItem,
  SelectValue,
  SettingsControls,
} from "@elizaos/app-core";
import { useApp } from "../../state";
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
            onValueChange={(value) => setPref("PARALLAX_AIDER_PROVIDER", value)}
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
            onValueChange={(value) =>
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
            onValueChange={(value) => setPref(`${prefix}_MODEL_FAST`, value)}
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

      {/* Only show the "configure API key" hint when the user is actually
          using direct provider keys. In cloud or subscription mode the
          fallback list is the expected source of truth, and Aider uses its
          own short aliases regardless. */}
      {llmProvider === "api_keys" && activeTab !== "aider" && (
        <SettingsControls.MutedText className="mt-1.5">
          {isDynamic
            ? t("codingagentsettingssection.ModelsFetched")
            : t("codingagentsettingssection.UsingFallback")}
        </SettingsControls.MutedText>
      )}
    </>
  );
}
