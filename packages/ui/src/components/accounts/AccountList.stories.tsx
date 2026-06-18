import type { Meta, StoryObj } from "@storybook/react";
import { withMockApp } from "../../storybook/mock-providers.helpers";
import { AccountList } from "./AccountList";

/**
 * AccountList fetches its data through `useAccounts` (`client.listAccounts`),
 * which has no backend in Storybook. The fetch rejects, so the component
 * settles into its empty state (heading + rotation picker + "Add account"
 * button + the empty-state hint). That is the realistic, useful render here.
 */
const meta = {
  title: "Accounts/AccountList",
  component: AccountList,
  tags: ["autodocs"],
  decorators: [withMockApp],
  args: {
    providerId: "openai" as never,
  },
} satisfies Meta<typeof AccountList>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const AnthropicProvider: Story = {
  args: {
    providerId: "anthropic" as never,
  },
};

export const Constrained: Story = {
  render: (args) => (
    <div className="max-w-md">
      <AccountList {...args} />
    </div>
  ),
};
