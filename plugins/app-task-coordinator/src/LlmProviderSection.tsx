import { Button, SettingsControls, useApp } from "@elizaos/ui";
import {
  AlertTriangle,
  CheckCircle2,
  Cloud,
  KeyRound,
  type LucideIcon,
  Terminal,
} from "lucide-react";
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
  const providerOptions: Array<{
    value: LlmProvider;
    label: string;
    icon: LucideIcon;
  }> = [
    {
      value: "subscription",
      label: t("codingagentsettingssection.LlmProviderSubscription", {
        defaultValue: "CLI Subscription",
      }),
      icon: Terminal,
    },
    {
      value: "api_keys",
      label: t("codingagentsettingssection.LlmProviderApiKeys", {
        defaultValue: "API Keys",
      }),
      icon: KeyRound,
    },
    {
      value: "cloud",
      label: t("codingagentsettingssection.LlmProviderCloud", {
        defaultValue: "Eliza Cloud",
      }),
      icon: Cloud,
    },
  ];

  return (
    <>
      <SettingsControls.Field>
        <SettingsControls.FieldLabel>
          {t("codingagentsettingssection.LlmProvider", {
            defaultValue: "LLM Provider",
          })}
        </SettingsControls.FieldLabel>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          {providerOptions.map((option) => {
            const Icon = option.icon;
            const active = llmProvider === option.value;
            return (
              <Button
                key={option.value}
                type="button"
                variant={active ? "default" : "outline"}
                size="sm"
                className="h-9 justify-start rounded-lg px-2.5 text-xs font-semibold"
                onClick={() => setPref("PARALLAX_LLM_PROVIDER", option.value)}
                aria-pressed={active}
              >
                <Icon className="h-3.5 w-3.5" aria-hidden />
                {option.label}
              </Button>
            );
          })}
        </div>
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
          </SettingsControls.Field>
        </div>
      )}

      {isCloud && (
        <div className="flex flex-col gap-3">
          {prefs._CLOUD_API_KEY ? (
            <SettingsControls.MutedText className="inline-flex items-center gap-1.5 text-xs text-ok">
              <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />
              {t("codingagentsettingssection.CloudPaired", {
                defaultValue:
                  "Using your Eliza Cloud account for coding agent LLM calls.",
              })}
            </SettingsControls.MutedText>
          ) : (
            <SettingsControls.MutedText className="inline-flex items-center gap-1.5 text-xs text-warn">
              <AlertTriangle className="h-3.5 w-3.5" aria-hidden />
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
