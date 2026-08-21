/**
 * Storybook states for the shared-agent onboarding overview and connector
 * interaction contracts, allowing review without Cloud credentials or a live
 * runtime.
 */

import type { Meta, StoryObj } from "@storybook/react";
import {
  ConnectorFirstInteractionGuide,
  SharedAgentFirstFiveMinutes,
} from "./SharedAgentFirstFiveMinutes";

const meta = {
  title: "Cloud/Connectors/SharedAgentFirstFiveMinutes",
  component: SharedAgentFirstFiveMinutes,
  tags: ["autodocs"],
} satisfies Meta<typeof SharedAgentFirstFiveMinutes>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Overview: Story = {};

export const ProviderGuides: Story = {
  render: () => (
    <div className="mx-auto max-w-4xl space-y-3 p-4">
      <ConnectorFirstInteractionGuide connector="telegram" />
      <ConnectorFirstInteractionGuide connector="blooio" />
      <ConnectorFirstInteractionGuide connector="twilio" />
    </div>
  ),
};
