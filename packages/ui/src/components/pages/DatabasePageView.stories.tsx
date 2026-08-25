/**
 * Storybook states for the Database page shell across self-contained tables,
 * media, and optional content-header layouts.
 */
import type { Meta, StoryObj } from "@storybook/react";
import { mockApp } from "../../storybook/mock-providers.helpers";
import { DatabasePageView } from "./DatabasePageView";

/**
 * DatabasePageView is the Database page shell: a segmented control switches
 * between the Tables, Media, and Vectors sub-views. The self-contained stories
 * below exercise the first two; the vector browser's separately served plugin
 * bundle is covered by the plugin-view browser lane. Each sub-view fetches its
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

/** Rendered without a content header passed in. */
export const NoContentHeader: Story = {
  args: { contentHeader: undefined },
  decorators: [mockApp({ databaseSubTab: "tables" })],
};
