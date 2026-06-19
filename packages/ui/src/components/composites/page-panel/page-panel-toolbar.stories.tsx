import type { Meta, StoryObj } from "@storybook/react";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { PagePanelToolbar } from "./page-panel-toolbar";

const meta = {
  title: "Composites/PagePanel/PagePanelToolbar",
  component: PagePanelToolbar,
  tags: ["autodocs"],
  args: {
    children: (
      <>
        <Input placeholder="Search plugins" className="max-w-xs" />
        <Button size="sm">Add plugin</Button>
      </>
    ),
  },
} satisfies Meta<typeof PagePanelToolbar>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const FiltersOnly: Story = {
  args: {
    children: (
      <>
        <Button variant="secondary" size="sm">
          All
        </Button>
        <Button variant="ghost" size="sm">
          Active
        </Button>
        <Button variant="ghost" size="sm">
          Disabled
        </Button>
      </>
    ),
  },
};

export const SearchWithActions: Story = {
  args: {
    children: (
      <>
        <Input placeholder="Filter agents" className="max-w-xs" />
        <Button variant="outline" size="sm">
          Refresh
        </Button>
        <Button size="sm">New agent</Button>
      </>
    ),
  },
};

export const Wrapping: Story = {
  args: {
    children: (
      <>
        <Button variant="ghost" size="sm">
          Memory
        </Button>
        <Button variant="ghost" size="sm">
          Providers
        </Button>
        <Button variant="ghost" size="sm">
          Connectors
        </Button>
        <Button variant="ghost" size="sm">
          Evaluators
        </Button>
        <Button variant="ghost" size="sm">
          Services
        </Button>
        <Button variant="ghost" size="sm">
          Routes
        </Button>
      </>
    ),
  },
};
