import type { Meta, StoryObj } from "@storybook/react";
import { withMockApp } from "../../storybook/mock-providers.helpers";
import { DatabaseView } from "./DatabaseView";

// DatabaseView fetches its database status + table list in a mount effect via
// the api `client`. In Storybook that call has no backend, so the component
// settles into its "connecting"/empty state — a faithful, useful first paint.
const meta = {
  title: "Pages/DatabaseView",
  component: DatabaseView,
  tags: ["autodocs"],
  decorators: [withMockApp],
  parameters: { layout: "fullscreen" },
  argTypes: {
    leftNav: { control: false },
    contentHeader: { control: false },
  },
} satisfies Meta<typeof DatabaseView>;

export default meta;
type Story = StoryObj<typeof meta>;

// Standalone layout (no external sidebar): renders the inline toolbar + table
// editor with its own collapsible table list.
export const Default: Story = {};

// Passing `leftNav` flips the component into its external-sidebar layout, which
// uses AppPageSidebar + the page-layout shell.
export const WithExternalSidebar: Story = {
  args: {
    leftNav: (
      <div className="rounded-sm border border-border/40 bg-card/60 px-3 py-2 text-xs text-muted">
        Workspace nav
      </div>
    ),
  },
};

// A custom content header is rendered above the main panel in the sidebar layout.
export const WithContentHeader: Story = {
  args: {
    leftNav: (
      <div className="rounded-sm border border-border/40 bg-card/60 px-3 py-2 text-xs text-muted">
        Workspace nav
      </div>
    ),
    contentHeader: (
      <div className="px-4 py-2 text-sm font-semibold text-txt-strong">
        Production database
      </div>
    ),
  },
};
