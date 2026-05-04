import type { Meta, StoryObj } from "@storybook/react";
import { HoverTooltip, IconTooltip } from "../components/ui/tooltip-extended";

const meta = {
  title: "UI/TooltipExtended",
  component: HoverTooltip,
  tags: ["autodocs"],
} satisfies Meta<typeof HoverTooltip>;

export default meta;
type Story = StoryObj<typeof meta>;

export const HoverTop: Story = {
  render: () => (
    <div className="p-16">
      <HoverTooltip
        content={<span className="text-sm">Tooltip on top</span>}
        position="top"
      >
        <span className="rounded-md border border-input bg-bg px-4 py-2 text-sm">
          Hover me (top)
        </span>
      </HoverTooltip>
    </div>
  ),
};

export const HoverBottom: Story = {
  render: () => (
    <div className="p-16">
      <HoverTooltip
        content={<span className="text-sm">Tooltip on bottom</span>}
        position="bottom"
      >
        <span className="rounded-md border border-input bg-bg px-4 py-2 text-sm">
          Hover me (bottom)
        </span>
      </HoverTooltip>
    </div>
  ),
};

export const HoverLeft: Story = {
  render: () => (
    <div className="p-16 pl-48">
      <HoverTooltip
        content={<span className="text-sm">Tooltip on left</span>}
        position="left"
      >
        <span className="rounded-md border border-input bg-bg px-4 py-2 text-sm">
          Hover me (left)
        </span>
      </HoverTooltip>
    </div>
  ),
};

export const HoverRight: Story = {
  render: () => (
    <div className="p-16">
      <HoverTooltip
        content={<span className="text-sm">Tooltip on right</span>}
        position="right"
      >
        <span className="rounded-md border border-input bg-bg px-4 py-2 text-sm">
          Hover me (right)
        </span>
      </HoverTooltip>
    </div>
  ),
};

export const IconWithLabel: Story = {
  render: () => (
    <div className="p-16">
      <IconTooltip label="Save document" shortcut="Ctrl+S">
        <button
          type="button"
          className="rounded-md border border-input bg-bg p-2 text-sm"
        >
          Save
        </button>
      </IconTooltip>
    </div>
  ),
};

export const IconBottomPosition: Story = {
  render: () => (
    <div className="p-16">
      <IconTooltip label="Delete item" position="bottom">
        <button
          type="button"
          className="rounded-md border border-input bg-bg p-2 text-sm"
        >
          Delete
        </button>
      </IconTooltip>
    </div>
  ),
};

export const SpotlightDemo: Story = {
  render: () => (
    <div className="relative">
      <div
        data-spotlight-target="demo"
        className="rounded-md border border-input bg-bg px-4 py-2 text-sm"
      >
        Target Element
      </div>
      <p className="mt-4 text-xs text-muted">
        Spotlight requires a DOM target matched by CSS selector. In production
        it overlays the page with a cutout around the target element. See the
        Spotlight component and useGuidedTour hook for full tour functionality.
      </p>
    </div>
  ),
};
