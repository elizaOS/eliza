/** Storybook stories for LogsView, seeded with static sample log entries across levels/sources. */

import type { Meta, StoryObj } from "@storybook/react";
import { mockApp, withMockApp } from "../../storybook/mock-providers.helpers";
import { LogsView } from "./LogsView";

const now = Date.now();

const sampleLogs = [
  {
    timestamp: now - 1000,
    level: "info",
    source: "agent",
    tags: ["agent", "plugins"],
    message: "Agent runtime booted with 12 plugins loaded.",
  },
  {
    timestamp: now - 5000,
    level: "warn",
    source: "server",
    tags: ["server", "websocket"],
    message: "WebSocket reconnect attempt 2 of 5.",
  },
  {
    timestamp: now - 9000,
    level: "error",
    source: "cloud",
    tags: ["cloud"],
    message: "Failed to sync model routing table: upstream timeout.",
  },
  {
    timestamp: now - 14000,
    level: "debug",
    source: "autonomy",
    tags: ["autonomy", "system"],
    message: "Evaluator pass completed in 42ms.",
  },
];

const populatedApp = {
  logs: sampleLogs,
  logSources: ["agent", "server", "cloud", "autonomy"],
  logTags: ["agent", "server", "cloud", "autonomy", "plugins", "websocket"],
  logTagFilter: "",
  logLevelFilter: "",
  logSourceFilter: "",
  logLoadError: "",
  loadLogs: () => Promise.resolve(),
};

const meta: Meta<typeof LogsView> = {
  title: "Pages/LogsView",
  component: LogsView,
  tags: ["autodocs"],
  decorators: [withMockApp],
};

export default meta;
type Story = StoryObj<typeof LogsView>;

export const Default: Story = {
  decorators: [mockApp(populatedApp)],
};

export const FilteredByLevel: Story = {
  decorators: [mockApp({ ...populatedApp, logLevelFilter: "error" })],
};

export const Empty: Story = {
  decorators: [
    mockApp({
      logs: [],
      logSources: [],
      logTags: [],
      logTagFilter: "",
      logLevelFilter: "",
      logSourceFilter: "",
      logLoadError: "",
      loadLogs: () => Promise.resolve(),
    }),
  ],
};

export const LoadError: Story = {
  decorators: [
    mockApp({
      ...populatedApp,
      logs: [],
      logLoadError: "Connection refused (ECONNREFUSED)",
    }),
  ],
};
