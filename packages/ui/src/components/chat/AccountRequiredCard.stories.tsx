import type { Meta, StoryObj } from "@storybook/react";
import type { ConnectorAccountRecord } from "../../api/client-agent";
import { AccountRequiredCard } from "./AccountRequiredCard";

const noop = () => {};

const accounts: ConnectorAccountRecord[] = [
  {
    id: "acct_primary",
    provider: "telegram",
    connectorId: "telegram",
    label: "Personal",
    handle: "@ada",
    status: "connected",
    role: "owner",
  },
  {
    id: "acct_work",
    provider: "telegram",
    connectorId: "telegram",
    label: "Work",
    handle: "@ada-work",
    status: "needs-reauth",
  },
  {
    id: "acct_old",
    provider: "telegram",
    connectorId: "telegram",
    label: "Legacy bot",
    externalId: "5512345678",
    status: "disconnected",
    enabled: false,
  },
];

const meta = {
  title: "Chat/AccountRequiredCard",
  component: AccountRequiredCard,
  tags: ["autodocs"],
  argTypes: {
    title: { control: "text" },
    description: { control: "text" },
    sourceLabel: { control: "text" },
    confirmLabel: { control: "text" },
    loading: { control: "boolean" },
    connectBusy: { control: "boolean" },
    confirmBusy: { control: "boolean" },
  },
  args: {
    accounts,
    selectedAccount: accounts[0],
    sourceLabel: "Telegram",
    onConfirm: noop,
    onConnectAccount: noop,
    onReconnectAccount: noop,
    onSelectAccount: noop,
  },
  decorators: [
    (Story) => (
      <div className="max-w-md p-4">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof AccountRequiredCard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const NoSelection: Story = {
  args: {
    selectedAccount: null,
    description: "Pick which Telegram account Eliza should send from.",
  },
};

export const Loading: Story = {
  args: {
    accounts: [],
    selectedAccount: null,
    loading: true,
  },
};

export const EmptyConnectOnly: Story = {
  args: {
    accounts: [],
    selectedAccount: null,
    title: "Connect a Telegram account",
    description:
      "No Telegram accounts are connected yet. Connect one to let Eliza send messages on your behalf.",
  },
};

export const BusyConfirm: Story = {
  args: {
    confirmBusy: true,
    confirmLabel: "Sending...",
  },
};

export const ReauthNeeded: Story = {
  args: {
    selectedAccount: accounts[1],
    accounts: [accounts[1], accounts[2]],
    title: "Reconnect required",
    description:
      "The selected account needs to be reconnected before Eliza can post.",
  },
};
