import type { Meta, StoryObj } from "@storybook/react";
import { PagePanelRoot } from "./page-panel-root";

const meta = {
  title: "Composites/PagePanel/PagePanelRoot",
  component: PagePanelRoot,
  tags: ["autodocs"],
  argTypes: {
    variant: {
      control: "select",
      options: ["surface", "section", "padded", "inset", "shell", "workspace"],
    },
    as: { control: "select", options: ["div", "section"] },
    className: { control: "text" },
  },
  args: {
    variant: "surface",
    children: (
      <div className="px-5 py-4 text-sm text-foreground">
        Panel content goes here. Use the variant control to switch surface
        treatments.
      </div>
    ),
  },
} satisfies Meta<typeof PagePanelRoot>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Surface: Story = {};

export const Padded: Story = {
  args: {
    variant: "padded",
    children: (
      <p className="text-sm text-foreground">
        The padded variant comes with built-in horizontal and vertical padding,
        suitable for short callouts or settings rows.
      </p>
    ),
  },
};

export const Section: Story = {
  args: {
    variant: "section",
    as: "section",
    children: (
      <div className="px-6 py-5">
        <h3 className="text-base font-medium text-foreground">
          Section heading
        </h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Sections wrap a logical group of content within a page.
        </p>
      </div>
    ),
  },
};

export const Workspace: Story = {
  args: {
    variant: "workspace",
    children: (
      <div className="flex flex-1 flex-col gap-3 p-6">
        <h2 className="text-lg font-semibold text-foreground">Workspace</h2>
        <p className="text-sm text-muted-foreground">
          Workspace panels take a tall minimum height and stack their children
          in a column, suitable for editor-like surfaces.
        </p>
      </div>
    ),
  },
};

export const Shell: Story = {
  args: {
    variant: "shell",
    children: (
      <div className="flex flex-1 items-center justify-center p-6 text-sm text-muted-foreground">
        Shell variant — flex container that fills its parent.
      </div>
    ),
  },
};
