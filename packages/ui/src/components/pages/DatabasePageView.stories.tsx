import type { Meta, StoryObj } from "@storybook/react";
import { mockApp } from "../../storybook/mock-providers.helpers";
import { DatabasePageView } from "./DatabasePageView";

/**
 * DatabasePageView is the Database page shell: a segmented control switches
 * between the Tables, Media, and Vectors sub-views. Each sub-view fetches its
 * own data from the API on mount; in Storybook there is no backend, so the
 * sub-views render their loading / empty states. The active tab is driven by
 * the `databaseSubTab` field of the app context.
 */
const meta = {
  title: "Pages/DatabasePageView",
  component: DatabasePageView,
  parameters: { layout: "fullscreen" },
  args: {
    contentHeader: (
      <div className="px-4 py-2 text-sm font-medium">Database</div>
    ),
  },
} satisfies Meta<typeof DatabasePageView>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Default landing on the Tables sub-view. */
export const Tables: Story = {
  decorators: [mockApp({ databaseSubTab: "tables" })],
};

/** Media gallery sub-view selected. */
export const Media: Story = {
  decorators: [mockApp({ databaseSubTab: "media" })],
};

/**
 * Vectors sub-view selected. This dynamically loads a heavy three.js vector
 * browser bundle from the API, which is unavailable in Storybook, so the
 * dynamic-view loader renders its loading / fallback state.
 */
export const Vectors: Story = {
  decorators: [mockApp({ databaseSubTab: "vectors" })],
};

/** Rendered without a content header passed in. */
export const NoContentHeader: Story = {
  args: { contentHeader: undefined },
  decorators: [mockApp({ databaseSubTab: "tables" })],
};
