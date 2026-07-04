/**
 * Story group for feature surfaces (local-inference, runs, downloads) with representative state.
 */
import type {
  ActiveModelState,
  AppRunSummary,
  DownloadJob,
  InstalledModel,
  RegistryAppInfo,
} from "@ui-src/api/index.ts";
import { AppIdentityTile } from "@ui-src/components/apps/app-identity.tsx";
import { RunningAppsRow } from "@ui-src/components/apps/RunningAppsRow.tsx";
import { ActiveModelBar } from "@ui-src/components/local-inference/ActiveModelBar.tsx";
import { DownloadProgress } from "@ui-src/components/local-inference/DownloadProgress.tsx";
import {
  ModelUpdatesPanel,
  type VoiceUpdatePreferencesView,
} from "@ui-src/components/local-inference/ModelUpdatesPanel.tsx";
import { PermissionRecoveryCallout } from "@ui-src/components/permissions/PermissionRecoveryCallout.tsx";
import { useState } from "react";
import type { StoryDefinition } from "../Story.tsx";

const noop = (): void => undefined;

const catalogApps: RegistryAppInfo[] = [
  {
    name: "model-lab",
    displayName: "Model Lab",
    description: "Local model workbench",
    category: "tools",
    launchType: "plugin-view",
    launchUrl: null,
    icon: null,
    heroImage: null,
    capabilities: ["viewer", "chat"],
    stars: 18,
    repository: "https://github.com/elizaOS/eliza",
    latestVersion: "2.0.3",
    supports: {},
    npm: {},
  },
  {
    name: "policy-console",
    displayName: "Policy Console",
    description: "Approval policy surface",
    category: "ops",
    launchType: "plugin-view",
    launchUrl: null,
    icon: null,
    heroImage: null,
    capabilities: ["control"],
    stars: 9,
    repository: "https://github.com/elizaOS/eliza",
    latestVersion: "2.0.3",
    supports: {},
    npm: {},
  },
];

const runningApps: AppRunSummary[] = [
  {
    runId: "run-model-lab",
    appName: "model-lab",
    displayName: "Model Lab",
    pluginName: "@elizaos/app-model-lab",
    launchType: "plugin-view",
    launchUrl: null,
    viewer: null,
    session: null,
    status: "running",
    summary: "Ready",
    startedAt: "2026-06-03T12:00:00.000Z",
    updatedAt: "2026-06-03T12:04:00.000Z",
    lastHeartbeatAt: "2026-06-03T12:04:00.000Z",
    supportsBackground: true,
    viewerAttachment: "embedded",
    health: { state: "healthy", message: null },
  },
  {
    runId: "run-policy-console",
    appName: "policy-console",
    displayName: "Policy Console",
    pluginName: "@elizaos/app-policy-console",
    launchType: "plugin-view",
    launchUrl: null,
    viewer: null,
    session: null,
    status: "running",
    summary: "Needs review",
    startedAt: "2026-06-03T12:01:00.000Z",
    updatedAt: "2026-06-03T12:03:00.000Z",
    lastHeartbeatAt: "2026-06-03T12:03:00.000Z",
    supportsBackground: true,
    viewerAttachment: "embedded",
    health: { state: "degraded", message: "One policy warning" },
    recentEvents: [
      {
        eventId: "evt-policy-warning",
        kind: "health",
        severity: "warning",
        message: "Rate limit near threshold",
        createdAt: "2026-06-03T12:03:00.000Z",
      },
    ],
  },
];

const installedModels: InstalledModel[] = [
  {
    id: "eliza-1-4b",
    displayName: "eliza-1-4B",
    path: "/models/eliza-1-4b.gguf",
    sizeBytes: 2_680_000_000,
    installedAt: "2026-06-01T08:00:00.000Z",
    lastUsedAt: "2026-06-03T11:55:00.000Z",
    source: "eliza-download",
  },
];

const activeModel: ActiveModelState = {
  modelId: "eliza-1-4b",
  loadedAt: "2026-06-03T11:55:00.000Z",
  status: "ready",
};

const downloadJob: DownloadJob = {
  jobId: "job-eliza-1-9b",
  modelId: "eliza-1-9b",
  state: "downloading",
  received: 1_740_000_000,
  total: 4_200_000_000,
  bytesPerSec: 18_200_000,
  etaMs: 135_000,
  startedAt: "2026-06-03T12:00:00.000Z",
  updatedAt: "2026-06-03T12:04:00.000Z",
};

function RunningAppsStory() {
  return (
    <div className="w-[min(760px,92vw)]">
      <RunningAppsRow
        runs={runningApps}
        catalogApps={catalogApps}
        busyRunId={null}
        stoppingRunId={null}
        onOpenRun={noop}
        onStopRun={noop}
      />
    </div>
  );
}

function AppIdentityStory() {
  return (
    <div className="flex items-center gap-4">
      {catalogApps.map((app) => (
        <div key={app.name} className="flex items-center gap-3">
          <AppIdentityTile app={app} active={app.name === "model-lab"} />
          <div>
            <div className="text-sm font-semibold text-txt">
              {app.displayName}
            </div>
            <div className="text-xs text-muted">{app.category}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

function ActiveModelStory() {
  return (
    <div className="w-[min(520px,86vw)]">
      <ActiveModelBar
        active={activeModel}
        installed={installedModels}
        busy={false}
        onUnload={noop}
      />
    </div>
  );
}

function DownloadProgressStory() {
  return (
    <div className="w-[min(520px,86vw)]">
      <DownloadProgress job={downloadJob} />
    </div>
  );
}

function ModelUpdatesStory() {
  const [preferences, setPreferences] = useState<VoiceUpdatePreferencesView>({
    autoUpdateOnWifi: true,
    autoUpdateOnCellular: false,
    autoUpdateOnMetered: false,
  });
  return (
    <div className="w-[min(760px,92vw)]">
      <ModelUpdatesPanel
        installations={[
          {
            id: "eliza-voice-default",
            installedVersion: "1.0.0",
            pinned: false,
          },
        ]}
        preferences={preferences}
        isOwner={true}
        lastCheckedAt="2026-06-03T12:00:00.000Z"
        onCheckNow={noop}
        onUpdateNow={noop}
        onTogglePin={noop}
        onSetPreferences={setPreferences}
      />
    </div>
  );
}

function PermissionRecoveryStory() {
  return (
    <div className="grid w-[min(960px,92vw)] gap-4 md:grid-cols-2">
      <PermissionRecoveryCallout
        permission="camera"
        title="Camera access is off"
        description="Enable camera access for Eliza, then return here to start the preview."
        onRetry={noop}
        testId="catalog-camera-permission-callout"
      />
      <PermissionRecoveryCallout
        permission="messages"
        title="SMS access is off"
        description="Eliza needs SMS permission before it can read threads or send a message from this device."
        onRetry={noop}
        testId="catalog-messages-permission-callout"
      />
      <div className="md:col-span-2">
        <PermissionRecoveryCallout
          permission="usage-access"
          title="Usage access is off"
          description="Open Android Usage Access, choose Eliza, and turn on Permit usage access to let app-blocking and focus checks work."
          settingsLabel="Open Usage Access"
          onRetry={noop}
          testId="catalog-usage-permission-callout"
        />
      </div>
    </div>
  );
}

export const featureSurfaceStories: StoryDefinition[] = [
  {
    id: "feature-running-apps-row",
    name: "RunningAppsRow",
    importPath:
      'import { RunningAppsRow } from "@elizaos/ui/components/apps/RunningAppsRow"',
    render: () => <RunningAppsStory />,
  },
  {
    id: "feature-app-identity",
    name: "AppIdentity",
    importPath:
      'import { AppIdentityTile } from "@elizaos/ui/components/apps/app-identity"',
    render: () => <AppIdentityStory />,
  },
  {
    id: "feature-active-model-bar",
    name: "ActiveModelBar",
    importPath:
      'import { ActiveModelBar } from "@elizaos/ui/components/local-inference/ActiveModelBar"',
    render: () => <ActiveModelStory />,
  },
  {
    id: "feature-download-progress",
    name: "DownloadProgress",
    importPath:
      'import { DownloadProgress } from "@elizaos/ui/components/local-inference/DownloadProgress"',
    render: () => <DownloadProgressStory />,
  },
  {
    id: "feature-model-updates-panel",
    name: "ModelUpdatesPanel",
    importPath:
      'import { ModelUpdatesPanel } from "@elizaos/ui/components/local-inference/ModelUpdatesPanel"',
    render: () => <ModelUpdatesStory />,
  },
  {
    id: "feature-permission-recovery-callout",
    name: "PermissionRecoveryCallout",
    importPath:
      'import { PermissionRecoveryCallout } from "@elizaos/ui/components/permissions/PermissionRecoveryCallout"',
    render: () => <PermissionRecoveryStory />,
  },
];
