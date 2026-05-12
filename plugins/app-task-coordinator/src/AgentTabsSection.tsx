import { type AgentPreflightResult, useApp } from "@elizaos/ui";
import { Button, SettingsControls } from "@elizaos/ui";
import {
  AlertTriangle,
  CheckCircle2,
  CircleHelp,
  ExternalLink,
  KeyRound,
  Loader2,
  RotateCw,
} from "lucide-react";
import {
  AGENT_LABELS,
  type AgentTab,
  type AuthResult,
  type LlmProvider,
} from "./coding-agent-settings-shared";

interface AgentTabsSectionProps {
  activeTab: AgentTab | null;
  availableAgents: AgentTab[];
  llmProvider: LlmProvider;
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
  preflightByAgent,
  authInProgress,
  authResult,
  getInstallState,
  onSelectAgent,
  onAuth,
}: AgentTabsSectionProps) {
  const { t } = useApp();
  const activeNeedsAuth = Boolean(
    activeTab &&
      llmProvider === "subscription" &&
      getInstallState(activeTab) === "installed" &&
      preflightByAgent[activeTab]?.auth?.status === "unauthenticated",
  );
  const activeAuthenticating =
    activeTab != null && authInProgress === activeTab;

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
          const statusLabel =
            installState === "installed"
              ? t("codingagentsettingssection.Installed")
              : installState === "missing"
                ? t("codingagentsettingssection.NotInstalled")
                : t("codingagentsettingssection.Unknown");

          return (
            <Button
              key={agent}
              variant={active ? "default" : "ghost"}
              size="sm"
              className={`flex-1 h-9 rounded-lg border px-3 py-2 text-xs font-semibold ${
                active
                  ? "bg-accent text-accent-fg dark:text-accent-fg shadow-sm"
                  : needsAuth
                    ? "border-warn/30 text-warn hover:bg-warn/10 hover:text-warn"
                    : "border-transparent text-muted hover:bg-bg-hover hover:text-txt"
              }`}
              onClick={() => onSelectAgent(agent)}
              aria-label={`${AGENT_LABELS[agent]} ${statusLabel}`}
            >
              <span className="inline-flex items-center gap-1.5">
                <span>{AGENT_LABELS[agent]}</span>
                {isAuthenticating ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                ) : needsAuth ? (
                  <KeyRound className="h-3.5 w-3.5" aria-hidden />
                ) : (
                  <InstallStateIcon state={installState} label={statusLabel} />
                )}
              </span>
            </Button>
          );
        })}
      </SettingsControls.SegmentedGroup>

      {activeTab && activeNeedsAuth && (
        <div className="mt-1.5 flex items-center justify-between gap-2 rounded-lg border border-warn/25 bg-warn/5 px-2.5 py-2 text-xs text-warn">
          <div className="inline-flex min-w-0 items-center gap-1.5">
            <KeyRound className="h-3.5 w-3.5 shrink-0" aria-hidden />
            <span className="truncate">
              {t("codingagentsettingssection.AuthenticationRequired", {
                defaultValue: "Authentication required",
              })}
            </span>
          </div>
          <Button
            variant="ghost"
            size="sm"
            disabled={activeAuthenticating}
            className="h-7 shrink-0 rounded-md px-2 text-xs font-semibold text-warn hover:bg-warn/10 hover:text-warn"
            onClick={() => onAuth(activeTab)}
          >
            {activeAuthenticating ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
            ) : (
              <KeyRound className="h-3.5 w-3.5" aria-hidden />
            )}
            {t("codingagentsettingssection.SignIn", {
              defaultValue: "Sign in",
            })}
          </Button>
        </div>
      )}

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
                defaultValue: "Open sign-in page",
              })}
              <ExternalLink className="inline h-3 w-3" aria-hidden />
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
                size="icon"
                className="h-7 w-7 rounded-md"
                aria-label={t("codingagentsettingssection.Retry", {
                  defaultValue: "Retry",
                })}
                title={t("codingagentsettingssection.Retry", {
                  defaultValue: "Retry",
                })}
                disabled={authInProgress !== null}
                onClick={() => onAuth(authResult.agent)}
              >
                <RotateCw className="h-3.5 w-3.5" aria-hidden />
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
    </>
  );
}

function InstallStateIcon({
  state,
  label,
}: {
  state: "installed" | "missing" | "unknown";
  label: string;
}) {
  if (state === "installed") {
    return (
      <CheckCircle2
        className="h-3.5 w-3.5 text-ok"
        aria-label={label}
        role="img"
      />
    );
  }
  if (state === "missing") {
    return (
      <AlertTriangle
        className="h-3.5 w-3.5 text-muted"
        aria-label={label}
        role="img"
      />
    );
  }
  return (
    <CircleHelp
      className="h-3.5 w-3.5 text-warn"
      aria-label={label}
      role="img"
    />
  );
}
