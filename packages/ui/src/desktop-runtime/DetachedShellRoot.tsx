import {
  type ComponentType,
  type JSX,
  type LazyExoticComponent,
  lazy,
  type ReactNode,
  Suspense,
} from "react";
import { ConversationsSidebar } from "../components/conversations/ConversationsSidebar";
import { ChatView } from "../components/pages/ChatView";
import { ConfigPageView } from "../components/pages/ConfigPageView";
import { CloudDashboard } from "../components/pages/ElizaCloudDashboard";
import { HeartbeatsView } from "../components/pages/HeartbeatsView";
import type { PageScope } from "../components/pages/page-scoped-conversations";
import { ReleaseCenterView } from "../components/pages/ReleaseCenterView";
import { PermissionsSection } from "../components/settings/PermissionsSection";
import { ProviderSwitcher } from "../components/settings/ProviderSwitcher";
import { VoiceConfigView } from "../components/settings/VoiceConfigView";
import { PairingView } from "../components/shell/PairingView";
import { StartupFailureView } from "../components/shell/StartupFailureView";
import { AppWorkspaceChrome } from "../components/workspace/AppWorkspaceChrome";
import {
  resolveDetachedShellTarget,
  type WindowShellRoute,
} from "../platform/window-shell";
import { CodingAgentSettingsSection } from "../slots/task-coordinator-slots.js";
import { useApp } from "../state/useApp";

interface DetachedShellRootProps {
  route: Exclude<WindowShellRoute, { mode: "main" }>;
}

type ExtractComponent<TValue> =
  TValue extends ComponentType<infer Props> ? ComponentType<Props> : never;

function lazyNamedView<
  TModule extends Record<string, unknown>,
  TKey extends keyof TModule,
>(
  load: () => Promise<TModule>,
  exportName: TKey,
): LazyExoticComponent<ExtractComponent<TModule[TKey]>> {
  return lazy(async () => {
    const module = await load();
    const component = module[exportName];
    if (typeof component !== "function") {
      throw new Error(`Missing component export: ${String(exportName)}`);
    }
    return {
      default: component as ExtractComponent<TModule[TKey]>,
    };
  });
}

const BrowserWorkspaceView = lazyNamedView(
  () => import("../components/pages/BrowserWorkspaceView"),
  "BrowserWorkspaceView",
);

// Static import: PluginsPageView is statically imported by App.tsx and
// AppWindowRenderer; a lazy() here can't move it into a separate chunk
// and just adds a wasted Suspense boundary.
import { PluginsPageView } from "../components/pages/PluginsPageView";

const SettingsView = lazyNamedView(
  () => import("../components/pages/SettingsView"),
  "SettingsView",
);

function DetachedLazyBoundary({ children }: { children: JSX.Element }) {
  return (
    <Suspense
      fallback={
        <div className="flex flex-1 items-center justify-center text-sm text-muted">
          Loading…
        </div>
      }
    >
      {children}
    </Suspense>
  );
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

function DetachedWorkspaceView({
  children,
  chatScope,
}: {
  children: ReactNode;
  chatScope: PageScope;
}): JSX.Element {
  return (
    <AppWorkspaceChrome
      testId={`detached-${chatScope}`}
      chatScope={chatScope}
      main={
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          {children}
        </div>
      }
    />
  );
}

function OnboardingBlockedView(): JSX.Element {
  const { t } = useApp();
  return (
    <div
      data-testid="onboarding-ui-overlay"
      className="flex flex-col items-center justify-center flex-1 min-h-0 gap-4 text-center px-6"
    >
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
      return (
        <DetachedLazyBoundary>
          <BrowserWorkspaceView />
        </DetachedLazyBoundary>
      );
    case "chat":
      return <DetachedChatView />;
    case "plugins":
      return (
        <DetachedWorkspaceView chatScope="page-plugins">
          <DetachedLazyBoundary>
            <PluginsPageView />
          </DetachedLazyBoundary>
        </DetachedWorkspaceView>
      );
    case "triggers":
      return (
        <DetachedWorkspaceView chatScope="page-automations">
          <HeartbeatsView />
        </DetachedWorkspaceView>
      );
    case "settings":
      return (
        <DetachedWorkspaceView chatScope="page-settings">
          <DetachedLazyBoundary>
            <section className="w-full overflow-y-auto px-4 py-4 lg:px-6">
              <DetachedSettingsSectionView section={target.settingsSection} />
            </section>
          </DetachedLazyBoundary>
        </DetachedWorkspaceView>
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
  const { authRequired, onboardingComplete, retryStartup, startupError, t } =
    useApp();
  if (startupError) {
    return <StartupFailureView error={startupError} onRetry={retryStartup} />;
  }

  if (authRequired) {
    return <PairingView />;
  }

  if (!onboardingComplete) {
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
