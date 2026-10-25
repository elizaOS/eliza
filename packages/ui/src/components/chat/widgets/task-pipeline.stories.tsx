/**
 * Storybook states for the live inline `PlanChecklist` (#13536 §todos): the
 * pending → in_progress → completed todo list that mutates in place, rendered
 * both inside a task card and for a standalone `[CHECKLIST]` marker.
 */
import type { Meta, StoryObj } from "@storybook/react";
import { mockApp } from "../../../storybook/mock-providers.helpers";
import { ChecklistWidget, PlanChecklist } from "./task-pipeline";

const meta = {
  title: "Chat/Widgets/PlanChecklist",
  component: PlanChecklist,
  decorators: [mockApp()],
} satisfies Meta<typeof PlanChecklist>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A live plan mid-flight: one done, one active, the rest pending. */
export const InProgress: Story = {
  args: {
    title: "Plan",
    entries: [
      { content: "Back up the database", status: "completed" },
      { content: "Run the migration", status: "in_progress" },
      { content: "Verify downstream consumers", status: "pending" },
    ],
  },
};

/** Every item completed — all struck through. */
export const AllDone: Story = {
  args: {
    title: "Plan",
    entries: [
      { content: "Back up the database", status: "completed" },
      { content: "Run the migration", status: "completed" },
    ],
  },
};

export const StandaloneChecklistShell: Story = {
  render: (args) => <ChecklistWidget {...args} />,
  args: {
    title: "Checklist",
    entries: [
      { content: "Confirm the appointment time", status: "completed" },
      { content: "Send the reminder to Telegram", status: "in_progress" },
      { content: "Archive the old task", status: "pending" },
    ],
  },
};

export const StandaloneChecklistComplete: Story = {
  render: (args) => <ChecklistWidget {...args} />,
  args: {
    title: "Checklist",
    entries: [
      { content: "Confirm the appointment time", status: "completed" },
      { content: "Send the reminder to Telegram", status: "completed" },
    ],
  },
};

/** Nothing started yet. */
export const AllPending: Story = {
  args: {
    title: "Checklist",
    entries: [
      { content: "Draft the outline", status: "pending" },
      { content: "Write the first section", status: "pending" },
    ],
  },
};

/** Long items wrap without breaking the row. */
export const LongItems: Story = {
  args: {
    title: "Plan",
    entries: [
      {
        content:
          "Provision the multi-region database cluster and wait for every replica to acknowledge the write quorum before continuing",
        status: "in_progress",
      },
      { content: "Verify downstream consumers reconnected", status: "pending" },
    ],
  },
};
