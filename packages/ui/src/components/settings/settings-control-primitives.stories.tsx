/** Eager, lazy, and user-expanded states for advanced settings disclosure. */
import type { Meta, StoryObj } from "@storybook/react";
import { assert } from "../../storybook/home-widget-decorator";
import { AdvancedSettingsDisclosure } from "./settings-control-primitives";

const meta = {
  title: "Settings/AdvancedSettingsDisclosure",
  component: AdvancedSettingsDisclosure,
  parameters: { layout: "padded" },
  args: {
    children: <div data-testid="advanced-body">Provider timeout: 30s</div>,
  },
} satisfies Meta<typeof AdvancedSettingsDisclosure>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Closed: Story = {};
export const Open: Story = { args: { defaultOpen: true } };
export const LazyExpansion: Story = {
  args: { lazy: true },
  play: async ({ canvasElement }) => {
    assert(
      canvasElement.querySelector('[data-testid="advanced-body"]') === null,
      "lazy body starts unmounted",
    );
    const summary = canvasElement.querySelector("summary");
    assert(summary instanceof HTMLElement, "disclosure summary renders");
    summary.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert(
      canvasElement.querySelector('[data-testid="advanced-body"]') !== null,
      "lazy body mounts on expansion",
    );
  },
};
