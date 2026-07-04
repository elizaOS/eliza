/**
 * Storybook states for the agent memory dashboard as API-backed people, stats,
 * and memory feeds resolve into loading or empty states.
 */
import type { Meta, StoryObj } from "@storybook/react";
import { withMockApp } from "../../storybook/mock-providers.helpers";
import { MemoryViewerView } from "./MemoryViewerView";

/**
 * MemoryViewerView is the agent memory dashboard: a feed/browse toggle, a
 * people sidebar, and per-type stats. In Storybook the API client has no
 * backend, so fetches stay pending and the view paints its loading / empty
 * states — which is exactly what these stories capture.
 */
const meta = {
  title: "Pages/MemoryViewerView",
  component: MemoryViewerView,
  tags: ["autodocs"],
  decorators: [withMockApp],
  parameters: {
    layout: "fullscreen",
  },
} satisfies Meta<typeof MemoryViewerView>;

export default meta;

type Story = StoryObj<typeof meta>;

/** Default mount — feed view with stats and people loading. */
export const Default: Story = {};

/** With a custom content header slot rendered above the panels. */
export const WithContentHeader: Story = {
  args: {
    contentHeader: (
      <div className="rounded-sm border border-border/24 bg-card/35 px-4 py-2 text-sm text-txt">
        Agent memory · last synced just now
      </div>
    ),
  },
};
