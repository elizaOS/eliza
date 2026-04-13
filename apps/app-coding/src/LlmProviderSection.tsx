/**
 * LLM provider selector + per-mode detail panels.
 *
 * Renders:
 *   - the `PARALLAX_LLM_PROVIDER` Select (subscription / api_keys / cloud)
 *   - the per-provider API key inputs when in `api_keys` mode
 *   - the cloud-pair status line when in `cloud` mode
 *
 * Extracted from `CodingAgentSettingsSection.tsx` to keep that file
 * under the project's ~500 LOC guideline. Parent owns `prefs` state
 * and passes `setPref` down.
 */

import {
  Select,
  SelectContent,
  SelectItem,
  SelectValue,
  SettingsControls,
} from "@elizaos/app-core";
import { useApp } from "@elizaos/app-core/state";
import type { LlmProvider } from "./coding-agent-settings-shared";

interface LlmProviderSectionProps {
  llmProvider: LlmProvider;
  isCloud: boolean;
  prefs: Record<string, string>;
  setPref: (key: string, value: string) => void;
}

export function LlmProviderSection({
  llmProvider,
  isCloud,
  prefs,
  setPref,
}: LlmProviderSectionProps) {
  const { t } = useApp();
  return (
    <>
      <SettingsControls.Field>
        <SettingsControls.FieldLabel>
          {t("codingagentsettingssection.LlmProvider", {
            defaultValue: "LLM Provider",
          })}
        </SettingsControls.FieldLabel>
        <Select
          value={llmProvider}
          onValueChange={(value) => setPref("PARALLAX_LLM_PROVIDER", value)}
        >
          <SettingsControls.SelectTrigger variant="compact">
            <SelectValue />
          </SettingsControls.SelectTrigger>
          <SelectContent>
            <SelectItem value="subscription">
              {t("codingagentsettingssection.LlmProviderSubscription", {
                defaultValue: "CLI Subscription",
              })}
            </SelectItem>
            <SelectItem value="api_keys">
              {t("codingagentsettingssection.LlmProviderApiKeys", {
                defaultValue: "API Keys",
              })}
            </SelectItem>
            <SelectItem value="cloud">
              {t("codingagentsettingssection.LlmProviderCloud", {
                defaultValue: "Eliza Cloud",
              })}
            </SelectItem>
          </SelectContent>
        </Select>
        <SettingsControls.FieldDescription>
          {llmProvider === "subscription"
            ? t("codingagentsettingssection.LlmProviderDescSubscription", {
                defaultValue:
                  "Use each CLI's built-in login (Claude Code, Codex, and Gemini subscriptions).",
              })
            : isCloud
              ? t("codingagentsettingssection.LlmProviderDescCloud", {
                  defaultValue:
                    "Route all agent LLM calls through Eliza Cloud. Gemini CLI is not supported.",
                })
              : t("codingagentsettingssection.LlmProviderDescApiKeys", {
                  defaultValue:
                    "Provide your own API keys for each provider (Anthropic, OpenAI, Google).",
                })}
        </SettingsControls.FieldDescription>
      </SettingsControls.Field>

      {llmProvider === "api_keys" && (
        <div className="flex flex-col gap-3">
          <SettingsControls.Field>
            <SettingsControls.FieldLabel>
              {t("codingagentsettingssection.AnthropicApiKey", {
                defaultValue: "Anthropic API Key",
              })}
            </SettingsControls.FieldLabel>
            <SettingsControls.Input
              variant="compact"
              type="password"
              placeholder="sk-ant-..."
              value={prefs.ANTHROPIC_API_KEY || ""}
              onChange={(e) => setPref("ANTHROPIC_API_KEY", e.target.value)}
            />
            <SettingsControls.FieldDescription>
              {t("codingagentsettingssection.AnthropicApiKeyDesc", {
                defaultValue: "For Claude Code and Aider (Anthropic provider).",
              })}
            </SettingsControls.FieldDescription>
          </SettingsControls.Field>
          <SettingsControls.Field>
            <SettingsControls.FieldLabel>
              {t("codingagentsettingssection.OpenaiApiKey", {
                defaultValue: "OpenAI API Key",
              })}
            </SettingsControls.FieldLabel>
            <SettingsControls.Input
              variant="compact"
              type="password"
              placeholder="sk-..."
              value={prefs.OPENAI_API_KEY || ""}
              onChange={(e) => setPref("OPENAI_API_KEY", e.target.value)}
            />
            <SettingsControls.FieldDescription>
              {t("codingagentsettingssection.OpenaiApiKeyDesc", {
                defaultValue: "For Codex and Aider (OpenAI provider).",
              })}
            </SettingsControls.FieldDescription>
          </SettingsControls.Field>
          <SettingsControls.Field>
            <SettingsControls.FieldLabel>
              {t("codingagentsettingssection.GoogleApiKey", {
                defaultValue: "Google API Key",
              })}
            </SettingsControls.FieldLabel>
            <SettingsControls.Input
              variant="compact"
              type="password"
              placeholder="AIza..."
              value={prefs.GOOGLE_GENERATIVE_AI_API_KEY || ""}
              onChange={(e) =>
                setPref("GOOGLE_GENERATIVE_AI_API_KEY", e.target.value)
              }
            />
            <SettingsControls.FieldDescription>
              {t("codingagentsettingssection.GoogleApiKeyDesc", {
                defaultValue: "For Gemini CLI and Aider (Google provider).",
              })}
            </SettingsControls.FieldDescription>
          </SettingsControls.Field>
        </div>
      )}

      {isCloud && (
        <div className="flex flex-col gap-3">
          {prefs._CLOUD_API_KEY ? (
            <SettingsControls.MutedText className="text-xs text-ok">
              {t("codingagentsettingssection.CloudPaired", {
                defaultValue:
                  "Using your Eliza Cloud account for coding agent LLM calls.",
              })}
            </SettingsControls.MutedText>
          ) : (
            <SettingsControls.MutedText className="text-xs text-warn">
              {t("codingagentsettingssection.CloudUnpaired", {
                defaultValue:
                  "No Eliza Cloud account connected. Pair your account in the Cloud settings section first.",
              })}
            </SettingsControls.MutedText>
          )}
        </div>
      )}
    </>
  );
}
