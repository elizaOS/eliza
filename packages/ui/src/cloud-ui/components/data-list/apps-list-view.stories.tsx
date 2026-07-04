/**
 * Storybook stories for AppsListView.
 */
import type { Meta, StoryObj } from "@storybook/react";
import type { ReactNode } from "react";

import { type AppsListItem, AppsListView } from "./apps-list-view";

const noop = () => {};

function renderAppLink({
  className,
  children,
}: {
  app: AppsListItem;
  className?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={className}
      onClick={(e) => e.preventDefault()}
    >
      {children}
    </button>
  );
}

const now = Date.now();

const baseApps: AppsListItem[] = [
  {
    id: "app-1",
    name: "Stargazer Bot",
    app_url: "https://stargazer.example.com",
    website_url: "https://stargazer.example.com",
    is_active: true,
    affiliate_code: "STAR-2024",
    total_users: 12480,
    total_requests: 1_204_311,
    updated_at: new Date(now - 4 * 60_000).toISOString(),
  },
  {
    id: "app-2",
    name: "Quiet Inbox",
    app_url: "https://quiet-inbox.example.com",
    website_url: null,
    is_active: true,
    affiliate_code: null,
    total_users: 842,
    total_requests: 91_204,
    updated_at: new Date(now - 3 * 3600_000).toISOString(),
  },
  {
    id: "app-3",
    name: "Legacy Concierge",
    app_url: "https://concierge.example.com",
    website_url: "https://concierge.example.com",
    is_active: false,
    affiliate_code: null,
    total_users: 12,
    total_requests: 304,
    updated_at: new Date(now - 9 * 86_400_000).toISOString(),
  },
];

const meta = {
  title: "CloudUI/DataList/AppsListView",
  component: AppsListView,
  tags: ["autodocs"],
  args: {
    apps: baseApps,
    renderAppLink,
    onCopyUrl: noop,
    onDeleteApp: noop,
  },
  decorators: [
    (Story) => (
      <div
        style={{
          background: "#0b0b0c",
          padding: 24,
          minHeight: 240,
        }}
      >
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof AppsListView>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const SingleActiveApp: Story = {
  args: {
    apps: [baseApps[0]],
  },
};

export const InactiveOnly: Story = {
  args: {
    apps: [
      {
        ...baseApps[2],
        name: "Disabled Worker",
        affiliate_code: null,
      },
    ],
  },
};

export const Deleting: Story = {
  args: {
    deletingId: "app-2",
  },
};

export const EmptyRendersNothing: Story = {
  args: {
    apps: [],
  },
};
