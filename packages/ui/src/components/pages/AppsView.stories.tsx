import type { Meta, StoryObj } from "@storybook/react";
import { mockApp } from "../../storybook/mock-providers.helpers";
import { AppsView } from "./AppsView";

/**
 * `AppsView` is the apps tab shell: a sidebar plus a catalog grid and a row of
 * running apps. It loads its catalog from the API on mount, so in Storybook
 * (no backend) it renders the loading state and then the empty/error catalog —
 * a faithful view of how the page looks before data arrives. All other state
 * comes from `useApp()`, which the `mockApp` decorator supplies.
 */
const meta = {
  title: "Pages/AppsView",
  component: AppsView,
  parameters: { layout: "fullscreen" },
  decorators: [mockApp()],
} satisfies Meta<typeof AppsView>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Fresh load: no favorites, no running apps, catalog still resolving. */
export const Default: Story = {};

/**
 * Wallet features enabled — the catalog filter keeps wallet-gated apps visible.
 */
export const WalletEnabled: Story = {
  decorators: [mockApp({ walletEnabled: true })],
};

/** A user with favorited and recently-launched apps. */
export const WithFavoritesAndRecents: Story = {
  decorators: [
    mockApp({
      favoriteApps: ["companion", "feed", "wallet"],
      recentApps: ["feed", "companion"],
    }),
  ],
};

/**
 * The "games" sub-tab selected. With no active run the page still renders its
 * catalog; this exercises the sub-tab branch of the shell state.
 */
export const GamesSubTab: Story = {
  decorators: [mockApp({ appsSubTab: "games" })],
};
