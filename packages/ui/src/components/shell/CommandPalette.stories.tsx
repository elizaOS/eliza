/**
 * Storybook states for the CommandPalette shell surface across startup,
 * launcher, banner, and overlay contexts.
 */
import type { Meta, StoryObj } from "@storybook/react";
import type * as React from "react";
import { BugReportProvider } from "../../hooks/BugReportProvider";
import { useBugReportState } from "../../hooks/useBugReport.hooks";
import { mockApp } from "../../storybook/mock-providers.helpers";
import { CommandPalette } from "./CommandPalette";

// Visibility is gated on `commandPaletteOpen` from useApp() — it drives the
// Dialog's `open` prop, so the palette only renders when that field is true.
// The component also reads `commandQuery` (trimmed) and `commandActiveIndex`
// during render, and calls useBugReport(), which throws without a provider.
// So every story forces the palette open via mockApp() and wraps it in a
// BugReportProvider.
function WithBugReport({ Story }: { Story: React.ComponentType }) {
  const bugReport = useBugReportState();
  return (
    <BugReportProvider value={bugReport}>
      <Story />
    </BugReportProvider>
  );
}

const meta = {
  title: "Shell/CommandPalette",
  component: CommandPalette,
  parameters: { layout: "fullscreen" },
  decorators: [(Story) => <WithBugReport Story={Story} />],
} satisfies Meta<typeof CommandPalette>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Open palette, empty query — every command listed, agent stopped. */
export const Default: Story = {
  decorators: [
    mockApp({
      commandPaletteOpen: true,
      commandQuery: "",
      commandActiveIndex: 0,
      agentStatus: { state: "stopped" },
      activeGameViewerUrl: "",
    }),
  ],
};

/** Query filters the list down to matching commands ("Open …" navigation). */
export const Filtered: Story = {
  decorators: [
    mockApp({
      commandPaletteOpen: true,
      commandQuery: "open",
      commandActiveIndex: 0,
      agentStatus: { state: "stopped" },
      activeGameViewerUrl: "",
    }),
  ],
};

/** Agent running — the palette surfaces Stop instead of Start. */
export const AgentRunning: Story = {
  decorators: [
    mockApp({
      commandPaletteOpen: true,
      commandQuery: "",
      commandActiveIndex: 0,
      agentStatus: { state: "running" },
      activeGameViewerUrl: "",
    }),
  ],
};

/** A query with no matches shows the empty-results state. */
export const NoResults: Story = {
  decorators: [
    mockApp({
      commandPaletteOpen: true,
      commandQuery: "zzzznomatch",
      commandActiveIndex: 0,
      agentStatus: { state: "stopped" },
      activeGameViewerUrl: "",
    }),
  ],
};
