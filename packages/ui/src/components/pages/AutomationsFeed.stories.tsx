/**
 * Storybook states for the automations feed, including backendless loading and
 * connected-credential context variants.
 */
import type { Meta, StoryObj } from "@storybook/react";
import { withMockApp } from "../../storybook/mock-providers.helpers";
import { AutomationsFeed } from "./AutomationsFeed";

/**
 * The Automations feed lists workflows and prompt automations in a single row format.
 * In Storybook there is no backend, so the on-mount fetch settles into the
 * empty / loading state — both are valid, useful renderings of the surface.
 */
const meta = {
  title: "Pages/AutomationsFeed",
  component: AutomationsFeed,
  tags: ["autodocs"],
  decorators: [withMockApp],
  parameters: {
    layout: "fullscreen",
  },
} satisfies Meta<typeof AutomationsFeed>;

export default meta;
type Story = StoryObj<typeof meta>;

/** No connected creds — the bare feed (loading skeleton → empty state). */
export const Default: Story = {};

/** Host has reported some already-connected credential types. */
export const WithConnectedCreds: Story = {
  args: {
    connectedCredTypes: new Set(["google", "github", "slack"]),
  },
};
