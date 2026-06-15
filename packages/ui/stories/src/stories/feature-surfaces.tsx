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
import { ApprovedAddressesSection } from "@ui-src/components/policy-controls/ApprovedAddressesSection.tsx";
import { AutoApproveSection } from "@ui-src/components/policy-controls/AutoApproveSection.tsx";
import { PolicyToggle } from "@ui-src/components/policy-controls/PolicyToggle.tsx";
import { RateLimitSection } from "@ui-src/components/policy-controls/RateLimitSection.tsx";
import { SpendingLimitSection } from "@ui-src/components/policy-controls/SpendingLimitSection.tsx";
import { TimeWindowSection } from "@ui-src/components/policy-controls/TimeWindowSection.tsx";
import type {
  ApprovedAddressesConfig,
  AutoApproveConfig,
  RateLimitConfig,
  SpendingLimitConfig,
  TimeWindowConfig,
} from "@ui-src/components/policy-controls/types.ts";
import { ShieldCheck } from "lucide-react";
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
    id: "qwen3-4b-instruct-q4",
    displayName: "Qwen3 4B Instruct Q4",
    path: "/models/qwen3-4b-instruct-q4.gguf",
    sizeBytes: 2_680_000_000,
    installedAt: "2026-06-01T08:00:00.000Z",
    lastUsedAt: "2026-06-03T11:55:00.000Z",
    source: "eliza-download",
  },
];

const activeModel: ActiveModelState = {
  modelId: "qwen3-4b-instruct-q4",
  loadedAt: "2026-06-03T11:55:00.000Z",
  status: "ready",
};

const downloadJob: DownloadJob = {
  jobId: "job-qwen3",
  modelId: "qwen3-8b-instruct-q4",
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

function PolicyToggleStory() {
  const [enabled, setEnabled] = useState(true);
  return (
    <div className="w-[min(520px,86vw)]">
      <PolicyToggle
        icon={ShieldCheck}
        title="Spending policy"
        summary="Under $25 per transaction"
        enabled={enabled}
        onToggle={setEnabled}
      >
        <p className="text-xs text-muted">
          Expanded content renders only when the policy is enabled.
        </p>
      </PolicyToggle>
    </div>
  );
}

function RateLimitStory() {
  const [config, setConfig] = useState<RateLimitConfig>({
    maxTxPerHour: 12,
    maxTxPerDay: 80,
  });
  return (
    <div className="w-[min(420px,86vw)]">
      <RateLimitSection config={config} onChange={setConfig} />
    </div>
  );
}

function SpendingLimitStory() {
  const [config, setConfig] = useState<SpendingLimitConfig>({
    maxPerTx: "25",
    maxPerDay: "250",
    maxPerWeek: "1000",
  });
  return (
    <div className="w-[min(620px,92vw)]">
      <SpendingLimitSection config={config} onChange={setConfig} />
    </div>
  );
}

function AutoApproveStory() {
  const [config, setConfig] = useState<AutoApproveConfig>({
    threshold: "5",
  });
  return (
    <div className="w-[min(420px,86vw)]">
      <AutoApproveSection config={config} onChange={setConfig} />
    </div>
  );
}

function TimeWindowStory() {
  const [config, setConfig] = useState<TimeWindowConfig>({
    allowedHours: [{ start: 9, end: 17 }],
    allowedDays: [1, 2, 3, 4, 5],
    timezone: "America/New_York",
  });
  return (
    <div className="w-[min(420px,86vw)]">
      <TimeWindowSection config={config} onChange={setConfig} />
    </div>
  );
}

function ApprovedAddressesStory() {
  const [config, setConfig] = useState<ApprovedAddressesConfig>({
    mode: "whitelist",
    addresses: [
      {
        address: "0x742d35Cc6634C0532925a3b844Bc454e4438f44e",
        label: "Treasury",
      },
    ],
    labels: {},
  });
  return (
    <div className="w-[min(620px,92vw)]">
      <ApprovedAddressesSection config={config} onChange={setConfig} />
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
    id: "feature-policy-toggle",
    name: "PolicyToggle",
    importPath:
      'import { PolicyToggle } from "@elizaos/ui/components/policy-controls/PolicyToggle"',
    render: () => <PolicyToggleStory />,
  },
  {
    id: "feature-rate-limit-section",
    name: "RateLimitSection",
    importPath:
      'import { RateLimitSection } from "@elizaos/ui/components/policy-controls/RateLimitSection"',
    render: () => <RateLimitStory />,
  },
  {
    id: "feature-spending-limit-section",
    name: "SpendingLimitSection",
    importPath:
      'import { SpendingLimitSection } from "@elizaos/ui/components/policy-controls/SpendingLimitSection"',
    render: () => <SpendingLimitStory />,
  },
  {
    id: "feature-auto-approve-section",
    name: "AutoApproveSection",
    importPath:
      'import { AutoApproveSection } from "@elizaos/ui/components/policy-controls/AutoApproveSection"',
    render: () => <AutoApproveStory />,
  },
  {
    id: "feature-time-window-section",
    name: "TimeWindowSection",
    importPath:
      'import { TimeWindowSection } from "@elizaos/ui/components/policy-controls/TimeWindowSection"',
    render: () => <TimeWindowStory />,
  },
  {
    id: "feature-approved-addresses-section",
    name: "ApprovedAddressesSection",
    importPath:
      'import { ApprovedAddressesSection } from "@elizaos/ui/components/policy-controls/ApprovedAddressesSection"',
    render: () => <ApprovedAddressesStory />,
  },
];
