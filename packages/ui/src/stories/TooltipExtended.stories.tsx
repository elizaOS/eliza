import type { Meta, StoryObj } from "@storybook/react";
import React from "react";
import {
  HoverTooltip,
  IconTooltip,
  Spotlight,
} from "../components/ui/tooltip-extended";

const meta: Meta = { title: "Molecules/TooltipExtended" };
export default meta;

export const HoverPositions: StoryObj = {
  render: () => (
    <div className="flex gap-16 items-center justify-center py-24">
      <HoverTooltip content="Top tooltip" position="top">
        <span className="px-3 py-1 border rounded text-sm">Top</span>
      </HoverTooltip>
      <HoverTooltip content="Bottom tooltip" position="bottom">
        <span className="px-3 py-1 border rounded text-sm">Bottom</span>
      </HoverTooltip>
      <HoverTooltip content="Left tooltip" position="left">
        <span className="px-3 py-1 border rounded text-sm">Left</span>
      </HoverTooltip>
      <HoverTooltip content="Right tooltip" position="right">
        <span className="px-3 py-1 border rounded text-sm">Right</span>
      </HoverTooltip>
    </div>
  ),
};

export const HoverWithDismiss: StoryObj = {
  render: () => (
    <div className="flex justify-center py-16">
      <HoverTooltip
        content={<span className="text-xs">Dismissable tooltip content</span>}
        position="bottom"
        visible
        onDismiss={() => alert("Dismissed!")}
      >
        <span className="px-3 py-1 border rounded text-sm">Always Visible</span>
      </HoverTooltip>
    </div>
  ),
};

export const HoverNoArrow: StoryObj = {
  render: () => (
    <div className="flex justify-center py-16">
      <HoverTooltip content="No arrow" position="top" showArrow={false}>
        <span className="px-3 py-1 border rounded text-sm">Hover me</span>
      </HoverTooltip>
    </div>
  ),
};

export const IconTooltips: StoryObj = {
  render: () => (
    <div className="flex gap-12 items-center justify-center py-16">
      <IconTooltip label="Settings" shortcut="⌘ ,">
        <button type="button" className="p-2 border rounded hover:bg-bg-hover">
          ⚙️
        </button>
      </IconTooltip>
      <IconTooltip label="Delete" position="bottom">
        <button type="button" className="p-2 border rounded hover:bg-bg-hover">
          🗑️
        </button>
      </IconTooltip>
    </div>
  ),
};

export const SpotlightOverlay: StoryObj = {
  render: () => (
    <div>
      <div className="flex gap-4 mb-8">
        <button
          type="button"
          id="spotlight-target"
          className="px-4 py-2 bg-accent text-accent-fg rounded"
        >
          Target Element
        </button>
        <span className="text-muted text-sm self-center">
          ← The spotlight highlights this button
        </span>
      </div>
      <Spotlight
        target="#spotlight-target"
        title="Welcome!"
        description="This is the target element. The spotlight creates a cutout overlay around it."
        step={1}
        totalSteps={3}
        onNext={() => {}}
        onPrev={() => {}}
        onSkip={() => {}}
      />
    </div>
  ),
};
