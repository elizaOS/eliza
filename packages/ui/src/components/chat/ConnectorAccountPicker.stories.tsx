/** Storybook + story-gate visual states for ConnectorAccountPicker. */
import type { Meta, StoryObj } from "@storybook/react";
import type { ConnectorAccountRecord } from "../../api/client-agent";
import { ConnectorAccountPicker } from "./ConnectorAccountPicker";

const accounts: ConnectorAccountRecord[] = [
  {
    id: "acc-personal",
    provider: "telegram",
    connectorId: "telegram",
    label: "Personal",
    handle: "@ada.lovelace",
    status: "connected",
    isDefault: true,
    enabled: true,
  },
  {
    id: "acc-work",
    provider: "telegram",
    connectorId: "telegram",
    label: "Work",
    handle: "@ada.work",
    status: "connected",
    enabled: true,
  },
  {
    id: "acc-broken",
    provider: "telegram",
    connectorId: "telegram",
    label: "Side project",
    handle: "@ada.side",
    status: "needs-reauth",
    statusDetail: "Token expired",
    enabled: true,
  },
  {
    id: "acc-disabled",
    provider: "telegram",
    connectorId: "telegram",
    label: "Old bot",
    externalId: "987654",
    status: "disconnected",
    enabled: false,
  },
];

const meta = {
  title: "Chat/ConnectorAccountPicker",
  component: ConnectorAccountPicker,
  tags: ["autodocs"],
  argTypes: {
    sourceLabel: { control: "text" },
    loading: { control: "boolean" },
    disabled: { control: "boolean" },
    connectBusy: { control: "boolean" },
    show: { control: "boolean" },
  },
  args: {
    accounts,
    selectedAccount: accounts[0],
    sourceLabel: "Telegram",
    onSelectAccount: () => {},
    onConnectAccount: () => {},
    onReconnectAccount: () => {},
  },
} satisfies Meta<typeof ConnectorAccountPicker>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const NoSelection: Story = {
  args: {
    selectedAccount: null,
  },
};

export const NeedsReconnect: Story = {
  args: {
    selectedAccount: accounts[2],
  },
};

export const Loading: Story = {
  args: {
    accounts: [],
    selectedAccount: null,
    loading: true,
  },
};

export const Empty: Story = {
  args: {
    accounts: [],
    selectedAccount: null,
  },
};

export const ConnectBusy: Story = {
  args: {
    connectBusy: true,
  },
};

export const Disabled: Story = {
  args: {
    disabled: true,
  },
};
