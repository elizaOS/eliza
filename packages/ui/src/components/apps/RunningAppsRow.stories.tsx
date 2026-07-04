/**
 * Storybook stories for `RunningAppsRow` across multiple runs, a single healthy
 * run, and the stop-button-enabled variant.
 */

import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";
import type { AppRunSummary, RegistryAppInfo } from "../../api";
import { RunningAppsRow } from "./RunningAppsRow";

function makeRun(overrides: Partial<AppRunSummary> = {}): AppRunSummary {
  const now = new Date().toISOString();
  return {
    runId: "run-1",
    appName: "wallet",
    displayName: "Wallet",
    pluginName: "plugin-wallet",
    launchType: "iframe",
    launchUrl: "https://example.com/wallet",
    viewer: { url: "https://example.com/wallet" } as AppRunSummary["viewer"],
    session: null,
    status: "running",
    summary: "Tracking balances",
    startedAt: now,
    updatedAt: now,
    lastHeartbeatAt: now,
    supportsBackground: true,
    viewerAttachment: "attached",
    health: { state: "healthy", message: null },
    ...overrides,
  };
}

const catalogApps: RegistryAppInfo[] = [
  {
    name: "wallet",
    displayName: "Wallet",
    description: "Manage balances and transactions.",
    category: "money",
    launchType: "iframe",
    launchUrl: "https://example.com/wallet",
    icon: null,
    heroImage: null,
    capabilities: [],
    stars: 0,
    repository: "",
    latestVersion: "1.0.0",
    supports: {} as RegistryAppInfo["supports"],
    npm: {} as RegistryAppInfo["npm"],
  },
];

const runs: AppRunSummary[] = [
  makeRun({ runId: "run-1", appName: "wallet", displayName: "Wallet" }),
  makeRun({
    runId: "run-2",
    appName: "arcade",
    displayName: "Arcade",
    health: { state: "degraded", message: "High latency" },
  }),
  makeRun({
    runId: "run-3",
    appName: "monitor",
    displayName: "Monitor",
    health: { state: "offline", message: "Run is offline" },
    viewerAttachment: "detached",
    lastHeartbeatAt: null,
  }),
];

const meta = {
  title: "Apps/RunningAppsRow",
  component: RunningAppsRow,
  parameters: { layout: "padded" },
  args: {
    runs,
    catalogApps,
    busyRunId: null,
    stoppingRunId: null,
    onOpenRun: () => {},
  },
} satisfies Meta<typeof RunningAppsRow>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const SingleHealthyRun: Story = {
  args: { runs: [makeRun()] },
};

export const WithStopButton: Story = {
  render: (args) => {
    const [stoppingRunId, setStoppingRunId] = useState<string | null>(null);
    return (
      <RunningAppsRow
        {...args}
        stoppingRunId={stoppingRunId}
        onStopRun={(run) => setStoppingRunId(run.runId)}
      />
    );
  },
};
