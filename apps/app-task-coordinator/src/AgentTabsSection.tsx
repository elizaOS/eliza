import { useApp, type AgentPreflightResult } from "@elizaos/app-core";
import { Button } from "@elizaos/ui/components/ui/button";
import { SettingsControls } from "@elizaos/ui/components/ui/settings-controls";
import {
  AGENT_LABELS,
  AGENT_TABS,
  type AgentTab,
  type AuthResult,
  type LlmProvider,
} from "./coding-agent-settings-shared";

interface AgentTabsSectionProps {
  activeTab: AgentTab | null;
  setActiveTab: (agent: AgentTab) => void;
  availableAgents: AgentTab[];
  llmProvider: LlmProvider;
  preflightLoaded: boolean;
  preflightByAgent: Partial<Record<AgentTab, AgentPreflightResult>>;
  authInProgress: AgentTab | null;
  authResult: AuthResult | null;
  getInstallState: (agent: AgentTab) => "installed" | "missing" | "unknown";
  onSelectAgent: (agent: AgentTab) => void;
  onAuth: (agent: AgentTab) => void;
}

export function AgentTabsSection({
  activeTab,
  availableAgents,
  llmProvider,
  preflightLoaded,
  preflightByAgent,
  authInProgress,
  authResult,
  getInstallState,
  onSelectAgent,
  onAuth,
}: AgentTabsSectionProps) {
  const { t } = useApp();
  return (
    <>
      <SettingsControls.SegmentedGroup>
        {availableAgents.map((agent) => {
          const active = activeTab === agent;
          const installState = getInstallState(agent);
          const needsAuth =
            llmProvider === "subscription" &&
            installState === "installed" &&
            preflightByAgent[agent]?.auth?.status === "unauthenticated";
          const isAuthenticating = authInProgress === agent;

          if (needsAuth) {
            return (
              <Button
                key={agent}
                variant="ghost"
                size="sm"
                disabled={isAuthenticating}
                className="flex-1 h-9 rounded-lg border border-warn/30 px-3 py-2 text-xs font-semibold text-warn hover:bg-warn/10 hover:text-warn"
                onClick={() => onAuth(agent)}
              >
                {isAuthenticating
                  ? t("codingagentsettingssection.AuthenticatingAgent", {
                      defaultValue: "Authenticating {{agent}}...",
                      agent: AGENT_LABELS[agent],
                    })
                  : t("codingagentsettingssection.AuthenticateAgent", {
                      defaultValue: "Authenticate {{agent}}",
                      agent: AGENT_LABELS[agent],
                    })}
              </Button>
            );
          }

          return (
            <Button
              key={agent}
              variant={active ? "default" : "ghost"}
              size="sm"
              className={`flex-1 h-9 rounded-lg border border-transparent px-3 py-2 text-xs font-semibold ${
                active
                  ? "bg-accent text-accent-fg dark:text-accent-fg shadow-sm"
                  : "text-muted hover:bg-bg-hover hover:text-txt"
              }`}
              onClick={() => onSelectAgent(agent)}
            >
              <span className="inline-flex items-center gap-1.5">
                <span>{AGENT_LABELS[agent]}</span>
                {installState === "installed" &&
                  llmProvider === "subscription" &&
                  preflightByAgent[agent]?.auth?.status === "authenticated" && (
                    <span className="text-2xs font-medium text-ok opacity-90">
                      ✓
                    </span>
                  )}
                {installState === "installed" &&
                  llmProvider !== "subscription" && (
                    <span className="text-2xs font-medium opacity-80">
                      {t("codingagentsettingssection.Installed")}
                    </span>
                  )}
                {installState === "unknown" && (
                  <span className="text-2xs font-medium opacity-70">
                    {t("codingagentsettingssection.Unknown")}
                  </span>
                )}
              </span>
            </Button>
          );
        })}
      </SettingsControls.SegmentedGroup>

      {authResult && (
        <div className="mt-1.5 flex flex-col gap-1.5">
          {authResult.url && (
            <a
              href={authResult.url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs font-medium text-accent hover:underline w-fit"
            >
              {t("codingagentsettingssection.OpenSignInPage", {
                defaultValue: "Open sign-in page →",
              })}
            </a>
          )}
          {authResult.deviceCode && (
            <SettingsControls.MutedText className="text-xs">
              {t("codingagentsettingssection.EnterDeviceCodePrefix", {
                defaultValue: "Enter code",
              })}{" "}
              <span className="font-mono font-bold select-all">
                {authResult.deviceCode}
              </span>{" "}
              {t("codingagentsettingssection.EnterDeviceCodeSuffix", {
                defaultValue: "at the sign-in page.",
              })}
            </SettingsControls.MutedText>
          )}
          {authResult.launched === false && (
            <div className="flex items-center gap-2">
              <SettingsControls.MutedText className="text-xs text-warn">
                {authResult.instructions}
              </SettingsControls.MutedText>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-2xs"
                disabled={authInProgress !== null}
                onClick={() => onAuth(authResult.agent)}
              >
                {t("codingagentsettingssection.Retry", {
                  defaultValue: "Retry",
                })}
              </Button>
            </div>
          )}
          {authResult.launched !== false &&
            !authResult.url &&
            !authResult.deviceCode &&
            authResult.instructions && (
              <SettingsControls.MutedText className="text-xs">
                {authResult.instructions}
              </SettingsControls.MutedText>
            )}
        </div>
      )}

      {preflightLoaded && (
        <SettingsControls.MutedText className="mt-1.5">
          {t("codingagentsettingssection.Availability")}{" "}
          {AGENT_TABS.map((agent) => {
            const installState = getInstallState(agent);
            const label =
              installState === "installed"
                ? t("codingagentsettingssection.Installed")
                : installState === "missing"
                  ? t("codingagentsettingssection.NotInstalled")
                  : t("codingagentsettingssection.Unknown");
            return `${AGENT_LABELS[agent]}: ${label}`;
          }).join(" · ")}
        </SettingsControls.MutedText>
      )}
    </>
  );
}
