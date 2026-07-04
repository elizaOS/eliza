/**
 * Storybook stories for the analytics ExportButton.
 */
import type { Meta, StoryObj } from "@storybook/react";
import { ExportButton } from "./export-button";

const meta = {
  title: "CloudUI/Analytics/ExportButton",
  component: ExportButton,
  tags: ["autodocs"],
  argTypes: {
    variant: { control: "select", options: ["simple", "dropdown"] },
    format: { control: "select", options: ["csv", "json", "excel"] },
    type: {
      control: "select",
      options: ["timeseries", "users", "providers", "models"],
    },
    granularity: {
      control: "select",
      options: ["hour", "day", "week", "month"],
    },
    onExport: { action: "exported" },
  },
  args: {
    startDate: "2026-05-01T00:00:00.000Z",
    endDate: "2026-06-01T00:00:00.000Z",
    granularity: "day",
    format: "csv",
    type: "timeseries",
    variant: "simple",
    onExport: (options) => {
      // No-op handler for stories; logs via Storybook actions.
      console.log("[ExportButton] export requested", options);
    },
  },
} satisfies Meta<typeof ExportButton>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Simple: Story = {};

export const SimpleJson: Story = {
  args: {
    format: "json",
    type: "providers",
  },
};

export const SimpleExcel: Story = {
  args: {
    format: "excel",
    type: "models",
  },
};

export const Dropdown: Story = {
  args: {
    variant: "dropdown",
  },
};

export const DropdownWeeklyRange: Story = {
  args: {
    variant: "dropdown",
    granularity: "week",
    startDate: "2026-01-01T00:00:00.000Z",
    endDate: "2026-06-01T00:00:00.000Z",
  },
};
