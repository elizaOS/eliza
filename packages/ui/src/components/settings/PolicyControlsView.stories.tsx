import type { Meta, StoryObj } from "@storybook/react";
import { mockApp, withMockApp } from "../../storybook/mock-providers.helpers";
import { PolicyControlsView } from "./PolicyControlsView";

/**
 * `PolicyControlsView` manages Steward wallet policy guardrails (auto-approve,
 * spending limits, rate limits, approved addresses, time windows).
 *
 * It takes no props and loads its data from the API client on mount. In
 * Storybook there is no backend, so `getStewardStatus()` rejects/hangs: the
 * component renders its in-flight loading spinner and then settles into the
 * "Steward Not Connected" empty state. Both are valid, useful states to review.
 */
const meta = {
  title: "Settings/PolicyControlsView",
  component: PolicyControlsView,
  tags: ["autodocs"],
  parameters: {
    layout: "padded",
  },
  decorators: [withMockApp],
  render: () => (
    <div className="max-w-md">
      <PolicyControlsView />
    </div>
  ),
} satisfies Meta<typeof PolicyControlsView>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * Default mount: shows the loading spinner, then the "Steward Not Connected"
 * empty state once the (unbacked) status request settles.
 */
export const Default: Story = {};

/**
 * Same view wrapped via `mockApp({...})` to demonstrate AppContext overrides;
 * the running agent status does not change the rendered policy states here, but
 * shows how to drive the harness for state-coupled siblings.
 */
export const RunningAgent: Story = {
  decorators: [mockApp({ agentStatus: { state: "running" } })],
};
