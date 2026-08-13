/**
 * Storybook stories for the LogViewer.
 */
import type { Meta, StoryObj } from "@storybook/react";
import * as React from "react";
import { LogViewer } from "./log-viewer";

const noop = () => {};

const SAMPLE_LINES = [
  "[2026-06-05T10:00:01Z] INFO  Server starting on port 3000",
  "[2026-06-05T10:00:02Z] INFO  Connected to database eliza_prod",
  "[2026-06-05T10:00:03Z] DEBUG Loaded 14 plugins",
  "[2026-06-05T10:00:04Z] WARN  Cache miss for key user:profile:42",
  "[2026-06-05T10:00:05Z] INFO  Agent eliza-1 registered with runtime",
  "[2026-06-05T10:00:06Z] ERROR Failed to dispatch action: TimeoutError",
  "[2026-06-05T10:00:07Z] INFO  Retry succeeded after 250ms",
  "[2026-06-05T10:00:08Z] INFO  Background worker tick complete",
];

const SAMPLE_ENTRIES = [
  {
    id: "1",
    timestamp: "2026-06-05T10:00:01Z",
    level: "info",
    message: "Server starting on port 3000",
  },
  {
    id: "2",
    timestamp: "2026-06-05T10:00:02Z",
    level: "debug",
    message: "Loaded 14 plugins",
    metadata: { count: 14, scope: "core" },
  },
  {
    id: "3",
    timestamp: "2026-06-05T10:00:03Z",
    level: "warn",
    message: "Cache miss for key user:profile:42",
  },
  {
    id: "4",
    timestamp: "2026-06-05T10:00:04Z",
    level: "error",
    message: "Failed to dispatch action: TimeoutError after 5000ms",
    metadata: { action: "send_message", retries: 3 },
  },
  {
    id: "5",
    timestamp: "2026-06-05T10:00:05Z",
    level: "info",
    message: "Recovery complete; resuming normal operation",
  },
];

const meta = {
  title: "CloudUI/Components/LogViewer",
  component: LogViewer,
  tags: ["autodocs"],
  parameters: {
    backgrounds: { default: "dark" },
    layout: "padded",
  },
  decorators: [
    (Story) => (
      <div
        className="bg-black p-3 sm:p-6"
        style={{ minWidth: "min(800px, 100%)" }}
      >
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof LogViewer>;

export default meta;
type Story = StoryObj<typeof meta>;

export const RawLines: Story = {
  args: {
    title: "agent.log",
    subtitle: "Live tail of the eliza-prod agent process",
    fetchedAt: "2026-06-05T10:00:08Z",
    badges: [{ label: "prod", variant: "outline" }],
    lines: SAMPLE_LINES,
    onRefresh: noop,
    onCopyAll: noop,
    onDownload: noop,
  },
};

export const StructuredEntries: Story = {
  args: {
    title: "runtime.events",
    subtitle: "Structured entries with level + metadata",
    badges: [
      { label: "structured", variant: "secondary" },
      { label: "v2", variant: "outline" },
    ],
    entries: SAMPLE_ENTRIES,
    onRefresh: noop,
    onCopyAll: noop,
    onCopyEntry: noop,
  },
};

export const InvalidTimestamps: Story = {
  render: () => (
    <LogViewer
      title="timestamp.validation"
      subtitle="Malformed values remain visible as intentionally unavailable"
      fetchedAt="2026-02-31T00:00:00Z"
      badges={[{ label: "validation", variant: "outline" }]}
      entries={[
        { id: "missing", message: "Missing timestamp is omitted" },
        {
          id: "malformed",
          timestamp: "not-a-date",
          message: "Malformed string",
        },
        { id: "nan", timestamp: Number.NaN, message: "Numeric NaN" },
        {
          id: "invalid-date",
          timestamp: new Date(Number.NaN),
          message: "Invalid object input",
        },
        {
          id: "time-clip",
          timestamp: 8.64e15 + 1,
          message: "Outside TimeClip range",
        },
        {
          id: "calendar-invalid",
          timestamp: "2026-02-31T00:00:00Z",
          message: "Calendar-invalid ISO timestamp",
        },
        {
          id: "valid",
          timestamp: "2026-06-05T10:00:00Z",
          message: "Valid control timestamp",
        },
      ]}
    />
  ),
  args: {
    title: "timestamp.validation",
  },
};

export const WithSearchAndFilter: Story = {
  render: (args) => {
    const [query, setQuery] = React.useState("error");
    const [level, setLevel] = React.useState("all");
    return (
      <LogViewer
        {...args}
        search={{
          value: query,
          onChange: setQuery,
          placeholder: "Search logs...",
          resultLabel: `Showing ${SAMPLE_ENTRIES.length} entries`,
        }}
        levelFilter={{
          value: level,
          onChange: setLevel,
          options: [
            { value: "all", label: "All levels" },
            { value: "info", label: "Info" },
            { value: "warn", label: "Warn" },
            { value: "error", label: "Error" },
            { value: "debug", label: "Debug" },
          ],
        }}
        lineCountControl={{
          value: "100",
          onChange: noop,
          options: [
            { value: "50", label: "50 lines" },
            { value: "100", label: "100 lines" },
            { value: "500", label: "500 lines" },
          ],
        }}
      />
    );
  },
  args: {
    title: "agent.log",
    entries: SAMPLE_ENTRIES,
    onRefresh: noop,
    onCopyAll: noop,
  },
};

export const Streaming: Story = {
  args: {
    title: "agent.log",
    subtitle: "Live streaming connected",
    lines: SAMPLE_LINES,
    onToggleStreaming: noop,
    onRefresh: noop,
    streaming: {
      enabled: true,
      active: true,
      activeLabel: "Live streaming enabled",
    },
  },
};

export const Loading: Story = {
  args: {
    title: "agent.log",
    subtitle: "Fetching the latest logs",
    loading: true,
  },
};

export const ErrorState: Story = {
  args: {
    title: "agent.log",
    error: "Connection refused on ws://api.eliza.local:3000/logs",
    onRetry: noop,
  },
};

export const Empty: Story = {
  args: {
    title: "agent.log",
    emptyState: {
      title: "No logs yet",
      description: "Logs will appear here once the agent starts running.",
    },
  },
};
