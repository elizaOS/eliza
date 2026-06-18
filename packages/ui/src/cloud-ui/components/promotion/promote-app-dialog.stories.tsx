import type { Meta, StoryObj } from "@storybook/react";
import { withMockApp } from "../../../storybook/mock-providers.helpers";
import { PromoteAppDialog } from "./promote-app-dialog";

const app = {
  id: "app_42",
  name: "Stargazer",
  description: "An astrology companion that charts your sky.",
  app_url: "https://stargazer.example.app",
};

const adAccounts = [
  { id: "acc_meta_1", platform: "meta", accountName: "Stargazer Ads" },
  { id: "acc_google_1", platform: "google", accountName: "Stargazer Search" },
];

const meta = {
  title: "Promotion/PromoteAppDialog",
  component: PromoteAppDialog,
  tags: ["autodocs"],
  decorators: [withMockApp],
  args: {
    open: true,
    onOpenChange: () => {},
    app,
  },
} satisfies Meta<typeof PromoteAppDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Opening step: pick channels. Advertising is locked with no ad accounts. */
export const Default: Story = {};

/** Advertising channel unlocked once ad accounts are connected. */
export const WithAdAccounts: Story = {
  args: {
    adAccounts,
  },
};

/** Dialog closed — renders nothing in the portal. */
export const Closed: Story = {
  args: {
    open: false,
  },
};

/** App with no description, longer name, and connected ad accounts. */
export const PopulatedApp: Story = {
  args: {
    app: {
      id: "app_99",
      name: "Hyperdrive Productivity Suite",
      app_url: "https://hyperdrive.example.app/launch",
    },
    adAccounts,
  },
};
