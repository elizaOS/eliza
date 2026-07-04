/**
 * Storybook coverage for the apps management settings panel and its backendless
 * loading, empty, error, and responsive toolbar states.
 */
import type { Meta, StoryObj } from "@storybook/react";
import { mockApp, withMockApp } from "../../storybook/mock-providers.helpers";
import { AppsManagementSection } from "./AppsManagementSection";

/**
 * `AppsManagementSection` self-manages its state and fetches the installed-app
 * inventory + active runs in a mount effect via the typed API client. In
 * Storybook there is no backend, so the fetch rejects and the panel settles into
 * its error/empty state after a brief loading spinner. The "Create new app" and
 * "Load from directory" entry points are fully interactive regardless of the API.
 */
const meta = {
  title: "Settings/AppsManagementSection",
  component: AppsManagementSection,
  tags: ["autodocs"],
  decorators: [withMockApp],
  parameters: { layout: "padded" },
} satisfies Meta<typeof AppsManagementSection>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Default: loading spinner resolving into the list/empty/error state. */
export const Default: Story = {};

/** Same panel rendered with the agent context reporting a running agent. */
export const AgentRunning: Story = {
  decorators: [mockApp({ agentStatus: { state: "running" } })],
};

/**
 * Wrapped in a narrow container to exercise the responsive toolbar wrap and the
 * horizontally scrollable apps table.
 */
export const Narrow: Story = {
  render: () => (
    <div className="max-w-sm">
      <AppsManagementSection />
    </div>
  ),
};
