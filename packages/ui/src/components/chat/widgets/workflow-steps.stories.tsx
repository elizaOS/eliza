/**
 * Storybook states for the inline WorkflowSteps widget (#13536 §(d)): the
 * ordered k/N pipeline an agent emits with a `[WORKFLOW]` block, across the
 * pending / mid-run / completed / failed step-status combinations the parser
 * feeds it.
 */
import type { Meta, StoryObj } from "@storybook/react";
import { mockApp } from "../../../storybook/mock-providers.helpers";
import type { WorkflowSpec } from "../message-workflow-parser";
import { WorkflowSteps } from "./workflow-steps";

function workflow(steps: WorkflowSpec["steps"], title?: string): WorkflowSpec {
  return { id: "wf-story", ...(title ? { title } : {}), steps };
}

const meta = {
  title: "Chat/Widgets/WorkflowSteps",
  component: WorkflowSteps,
  decorators: [mockApp()],
} satisfies Meta<typeof WorkflowSteps>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Nothing started yet — every step muted/pending. */
export const AllPending: Story = {
  args: {
    workflow: workflow(
      [
        { label: "Build image", status: "pending" },
        { label: "Push to registry", status: "pending" },
        { label: "Roll out", status: "pending" },
      ],
      "Deploy",
    ),
  },
};

/** Mid-run — one step done, one spinning, the rest pending. */
export const InProgress: Story = {
  args: {
    workflow: workflow(
      [
        { label: "Build image", status: "done" },
        { label: "Push to registry", status: "running" },
        { label: "Roll out", status: "pending" },
      ],
      "Deploy",
    ),
  },
};

/** Every step done — the completed pipeline. */
export const Completed: Story = {
  args: {
    workflow: workflow(
      [
        { label: "Build image", status: "done" },
        { label: "Push to registry", status: "done" },
        { label: "Roll out", status: "done" },
      ],
      "Deploy",
    ),
  },
};

/** A step failed — danger tone + the failed count. */
export const Failed: Story = {
  args: {
    workflow: workflow(
      [
        { label: "Build image", status: "done" },
        { label: "Push to registry", status: "failed" },
        { label: "Roll out", status: "pending" },
      ],
      "Deploy",
    ),
  },
};

/** No title falls back to the default "Workflow" heading. */
export const Untitled: Story = {
  args: {
    workflow: workflow([
      { label: "Collect inputs", status: "done" },
      { label: "Summarize", status: "running" },
    ]),
  },
};

/** Long step labels wrap without breaking the card. */
export const LongLabels: Story = {
  args: {
    workflow: workflow(
      [
        {
          label:
            "Provision the multi-region database cluster and wait for every replica to acknowledge the write quorum",
          status: "running",
        },
        {
          label: "Verify every downstream consumer reconnected cleanly",
          status: "pending",
        },
      ],
      "Migration",
    ),
  },
};
