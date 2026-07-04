/**
 * Storybook stories for `ConnectorAccountCard` covering the account states
 * (connected/owner default, other roles, error) under the translation provider.
 */

import type { Meta, StoryObj } from "@storybook/react";
import type { ConnectorAccountRecord } from "../../api/client-agent";
import { TranslationProvider } from "../../state/TranslationProvider";
import { ConnectorAccountCard } from "./ConnectorAccountCard";

const noop = async () => {};

const baseAccount: ConnectorAccountRecord = {
  id: "acct_01",
  provider: "telegram",
  connectorId: "telegram",
  label: "Personal Telegram",
  handle: "@ada",
  externalId: "847362",
  avatarUrl: "https://placehold.co/64x64/png",
  status: "connected",
  role: "OWNER",
  privacy: "owner_only",
  purpose: ["messaging"],
  isDefault: true,
  enabled: true,
  lastSyncedAt: Date.now() - 4 * 60_000,
};

const meta = {
  title: "Connectors/ConnectorAccountCard",
  component: ConnectorAccountCard,
  tags: ["autodocs"],
  parameters: { layout: "padded" },
  argTypes: {
    saving: { control: "boolean" },
    testBusy: { control: "boolean" },
    refreshBusy: { control: "boolean" },
    selected: { control: "boolean" },
    isDefault: { control: "boolean" },
  },
  args: {
    account: baseAccount,
    onUpdate: noop,
    onTest: noop,
    onRefresh: noop,
    onDelete: noop,
    onMakeDefault: noop,
  },
  decorators: [
    (Story) => (
      <TranslationProvider>
        <div className="max-w-2xl">
          <Story />
        </div>
      </TranslationProvider>
    ),
  ],
} satisfies Meta<typeof ConnectorAccountCard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Selectable: Story = {
  args: {
    account: { ...baseAccount, isDefault: false },
    selected: false,
    onSelect: () => {},
  },
};

export const NeedsReauth: Story = {
  args: {
    account: {
      ...baseAccount,
      id: "acct_02",
      label: "Work Telegram",
      handle: "@ada.work",
      isDefault: false,
      status: "needs-reauth",
      statusDetail: "Session expired 2h ago — re-authenticate to resume sync.",
      lastSyncedAt: Date.now() - 6 * 3_600_000,
    },
  },
};

export const PendingNoAvatar: Story = {
  args: {
    account: {
      ...baseAccount,
      id: "acct_03",
      label: "Team Broadcast",
      handle: null,
      avatarUrl: null,
      status: "pending",
      role: "TEAM",
      privacy: "team_visible",
      isDefault: false,
      lastSyncedAt: undefined,
    },
  },
};

export const DisconnectedAndDisabled: Story = {
  args: {
    account: {
      ...baseAccount,
      id: "acct_04",
      label: "Old Personal Account",
      handle: "@ada.old",
      avatarUrl: null,
      status: "disconnected",
      isDefault: false,
      enabled: false,
      lastSyncedAt: Date.now() - 12 * 86_400_000,
    },
  },
};

export const BusyStates: Story = {
  args: {
    saving: true,
    testBusy: true,
    refreshBusy: true,
    account: { ...baseAccount, isDefault: false },
  },
};
