/**
 * Storybook states for the Page Panel Collapsible Section page-panel primitive
 * used to compose dense dashboard pages.
 */
import type { Meta, StoryObj } from "@storybook/react";
import { PagePanelCollapsibleSection } from "./page-panel-collapsible-section";

const meta = {
  title: "Composites/PagePanel/PagePanelCollapsibleSection",
  component: PagePanelCollapsibleSection,
  tags: ["autodocs"],
  argTypes: {
    variant: {
      control: "select",
      options: ["section", "surface", "inset"],
    },
    as: { control: "select", options: ["div", "section"] },
    bordered: { control: "boolean" },
    defaultExpanded: { control: "boolean" },
    expandOnCollapsedSurfaceClick: { control: "boolean" },
    heading: { control: "text" },
    description: { control: "text" },
  },
  args: {
    heading: "Notification preferences",
    description: "Choose how and when you'd like to hear from your agent.",
    defaultExpanded: true,
    bordered: true,
    variant: "section",
    children: (
      <p className="text-sm text-muted-foreground">
        Daily check-ins arrive at 9:00 AM in your local time zone. You can pause
        them anytime from the quick actions menu.
      </p>
    ),
  },
} satisfies Meta<typeof PagePanelCollapsibleSection>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Expanded: Story = {};

export const Collapsed: Story = {
  args: {
    defaultExpanded: false,
  },
};

export const ClickToExpand: Story = {
  args: {
    defaultExpanded: false,
    expandOnCollapsedSurfaceClick: true,
    heading: "Connected integrations",
    description: "Click anywhere on this panel to reveal the details.",
  },
};

export const WithActions: Story = {
  args: {
    heading: "Sync schedule",
    description: "Background sync runs every 15 minutes.",
    actions: (
      <button
        type="button"
        className="rounded-md border border-border bg-background px-2.5 py-1 text-xs font-medium hover:bg-muted"
        onClick={() => {}}
      >
        Edit
      </button>
    ),
  },
};

export const SurfaceVariant: Story = {
  args: {
    variant: "surface",
    heading: "Storage usage",
    description: "You've used 4.2 GB of your 10 GB plan.",
    children: (
      <div className="space-y-2 text-sm">
        <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
          <div className="h-full w-[42%] rounded-full bg-primary" />
        </div>
        <p className="text-muted-foreground">
          Upgrade to expand your storage and unlock larger file uploads.
        </p>
      </div>
    ),
  },
};
