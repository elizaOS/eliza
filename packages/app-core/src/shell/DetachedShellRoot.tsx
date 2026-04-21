import { CodingAgentSettingsSection } from "@elizaos/app-task-coordinator";
import type { JSX } from "react";
import { ConversationsSidebar } from "../components/conversations/ConversationsSidebar";
import { BrowserWorkspaceView } from "../components/pages/BrowserWorkspaceView";
import { ChatView } from "../components/pages/ChatView";
import { ConfigPageView } from "../components/pages/ConfigPageView";
import { ConnectorsPageView } from "../components/pages/ConnectorsPageView";
import { CloudDashboard } from "../components/pages/ElizaCloudDashboard";
import { HeartbeatsView } from "../components/pages/HeartbeatsView";
import { PluginsPageView } from "../components/pages/PluginsPageView";
import { ReleaseCenterView } from "../components/pages/ReleaseCenterView";
import { SettingsView } from "../components/pages/SettingsView";
import { MediaSettingsSection } from "../components/settings/MediaSettingsSection";
import { PermissionsSection } from "../components/settings/PermissionsSection";
import { ProviderSwitcher } from "../components/settings/ProviderSwitcher";
import { VoiceConfigView } from "../components/settings/VoiceConfigView";
import { PairingView } from "../components/shell/PairingView";
import { StartupFailureView } from "../components/shell/StartupFailureView";
import {
  resolveDetachedShellTarget,
  type WindowShellRoute,
} from "../platform/window-shell";
import { useApp } from "../state/useApp";

interface DetachedShellRootProps {
  route: Exclude<WindowShellRoute, { mode: "main" }>;
}

function DetachedSettingsSectionView({
  section,
}: {
  section?: string;
}): JSX.Element {
  switch (section) {
    case "ai-model":
      return <ProviderSwitcher />;
    case "cloud":
      return <CloudDashboard />;
    case "coding-agents":
      return <CodingAgentSettingsSection />;
    case "wallet-rpc":
      return <ConfigPageView embedded />;
    case "media":
      return <MediaSettingsSection />;
    case "voice":
      return <VoiceConfigView />;
    case "permissions":
      return <PermissionsSection />;
    case "updates":
      return <ReleaseCenterView />;
    default:
      return <SettingsView initialSection={section} />;
  }
}

function DetachedChatView(): JSX.Element {
  const { t } = useApp();
  return (
    <div className="flex flex-1 min-h-0 relative">
      <nav aria-label={t("chat.conversations")}>
        <ConversationsSidebar />
      </nav>
      <div className="flex flex-col flex-1 min-h-0 min-w-0 overflow-hidden">
        <ChatView />
      </div>
    </div>
  );
}

function OnboardingBlockedView(): JSX.Element {
  const { t } = useApp();
  return (
    <div className="flex flex-col items-center justify-center flex-1 min-h-0 gap-4 text-center px-6">
      <div className="text-4xl">🎀</div>
      <h2 className="text-lg font-semibold text-txt">
        {t("detachedshell.SetupInProgress", {
          defaultValue: "Setup in progress",
        })}
      </h2>
      <p className="text-sm text-muted max-w-sm">
        {t("detachedshell.SetupInProgressDesc", {
          defaultValue:
            "Complete onboarding in the main window first. This window will become available once your agent is ready.",
        })}
      </p>
    </div>
  );
}

function DetachedShellContent({ route }: DetachedShellRootProps): JSX.Element {
  const { t } = useApp();
  const target = resolveDetachedShellTarget(route);

  switch (target.tab) {
    case "browser":
      return <BrowserWorkspaceView />;
    case "chat":
      return <DetachedChatView />;
    case "connectors":
      return <ConnectorsPageView />;
    case "plugins":
      return <PluginsPageView />;
    case "triggers":
      return <HeartbeatsView />;
    case "settings":
      return (
        <section className="w-full px-4 py-4 lg:px-6">
          <DetachedSettingsSectionView section={target.settingsSection} />
        </section>
      );
    default: {
      const _exhaustive: never = target.tab;
      return (
        <div className="flex flex-1 items-center justify-center text-sm text-muted">
          {t("detachedshell.UnknownView", {
            defaultValue: "Unknown view: {{view}}",
            view: String(_exhaustive),
          })}
        </div>
      );
    }
  }
}

export function DetachedShellRoot({
  route,
}: DetachedShellRootProps): JSX.Element {
  const {
    authRequired,
    onboardingComplete,
    onboardingLoading,
    retryStartup,
    startupError,
    t,
  } = useApp();
  if (startupError) {
    return <StartupFailureView error={startupError} onRetry={retryStartup} />;
  }

  if (authRequired) {
    return <PairingView />;
  }

  if (!onboardingLoading && !onboardingComplete) {
    return (
      <div className="flex h-full min-h-0 w-full flex-col font-body text-txt bg-bg">
        <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <OnboardingBlockedView />
        </main>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 w-full flex-col font-body text-txt bg-bg">
      <a
        href="#detached-main"
        className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:p-2 focus:bg-bg focus:text-txt"
      >
        {t("detachedshell.SkipToContent", {
          defaultValue: "Skip to content",
        })}
      </a>
      <main
        id="detached-main"
        className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
      >
        <DetachedShellContent route={route} />
      </main>
    </div>
  );
}
