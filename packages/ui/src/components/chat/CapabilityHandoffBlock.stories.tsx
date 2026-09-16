/** Storybook states for the in-chat capability setup handoff. */
import type { CapabilityHandoffRequest } from "@elizaos/shared";
import type { Meta, StoryObj } from "@storybook/react";
import { userEvent } from "storybook/test";
import { assert } from "../../storybook/home-widget-decorator";
import { CapabilityHandoffBlock } from "./CapabilityHandoffBlock";

const baseRequest = {
  version: 1,
  kind: "capability_handoff",
  capabilityId: "calendar",
  label: "Calendar",
  availability: "requires_upgrade",
  reason: "Calendar access needs a personal workspace.",
  currentTier: "shared",
  requiredTier: "personal",
  nextAction: "open_personal_workspace",
  requiresConfirmation: true,
  cta: {
    label: "Set up workspace",
    href: "/settings/agents/new",
  },
} satisfies CapabilityHandoffRequest;

const meta = {
  title: "Chat/CapabilityHandoffBlock",
  component: CapabilityHandoffBlock,
  parameters: { layout: "padded" },
  decorators: [
    (Story: () => React.JSX.Element) => (
      <div className="max-w-sm">
        <Story />
      </div>
    ),
  ],
  args: { request: baseRequest },
} satisfies Meta<typeof CapabilityHandoffBlock>;

export default meta;
type Story = StoryObj<typeof meta>;

export const SetupRequired: Story = {};

export const WithContinuation: Story = {
  args: {
    request: {
      ...baseRequest,
      continuation: {
        clientMessageId: "story-message-1",
        originalIntent: "Schedule lunch with Maya next Tuesday.",
      },
    },
  },
};

export const NavigationUnavailable: Story = {
  play: async ({ canvasElement }) => {
    const button = canvasElement.querySelector("button");
    assert(button instanceof HTMLButtonElement, "setup button renders");
    await userEvent.click(button);
    const alert = canvasElement.querySelector('[role="alert"]');
    assert(alert instanceof HTMLElement, "navigation failure is visible");
  },
};
