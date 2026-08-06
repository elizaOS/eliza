/** Launcher glyph and catalog fallback states for deterministic view imagery. */
import type { Meta, StoryObj } from "@storybook/react";
import type { ViewEntry } from "../../hooks/view-catalog";
import { ViewTileImage } from "./ViewTileImage";

const entry = {
  key: "view:calendar",
  id: "calendar",
  label: "Calendar",
  icon: "CalendarDays",
  hasHero: false,
  modality: "gui",
  state: "loaded",
  kind: "view",
  viewKind: "release",
} as ViewEntry;

const meta = {
  title: "Views/ViewTileImage",
  component: ViewTileImage,
  parameters: { layout: "centered" },
  args: {
    entry,
    source: "launcher",
    containerClassName: "h-20 w-20 rounded-2xl",
    glyphClassName: "h-8 w-8",
  },
} satisfies Meta<typeof ViewTileImage>;

export default meta;
type Story = StoryObj<typeof meta>;

export const LauncherGlyph: Story = {};
export const CatalogFallback: Story = {
  args: {
    source: "view-catalog",
    containerClassName: "h-40 w-64 overflow-hidden rounded-xl bg-bg-muted",
  },
};
