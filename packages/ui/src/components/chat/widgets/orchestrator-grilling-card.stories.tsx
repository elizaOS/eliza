/**
 * Storybook states for the Orchestrator Grilling Card chat widget across
 * populated, empty, and interaction-focused render states.
 */
import type { Meta, StoryObj } from "@storybook/react";
import type { ReactNode } from "react";
import type { GrillingCriterion } from "./orchestrator-grilling-card";
import { OrchestratorGrillingCard } from "./orchestrator-grilling-card";

// The card lives in the chat sidebar — render stories in a matching column.
function Sidebar({ children }: { children: ReactNode }) {
  return (
    <div className="w-[320px] rounded-lg border border-border/40 bg-bg/40 p-3">
      {children}
    </div>
  );
}

const meta = {
  title: "Chat/Widgets/OrchestratorGrillingCard",
  component: OrchestratorGrillingCard,
  tags: ["autodocs"],
  decorators: [
    (Story) => (
      <Sidebar>
        <Story />
      </Sidebar>
    ),
  ],
} satisfies Meta<typeof OrchestratorGrillingCard>;

export default meta;
type Story = StoryObj<typeof meta>;

const goal = "Add Storybook stories for the new chat widgets";

const baseCriteria: GrillingCriterion[] = [
  {
    id: "c1",
    label: "Every component has a matching .stories.tsx",
    state: "met",
    note: "6 of 6 components covered.",
  },
  {
    id: "c2",
    label: "Stories render with no console errors",
    state: "met",
  },
  {
    id: "c3",
    label: "Barrel exports the components and their public types",
    state: "met",
  },
];

export const EvidencePending: Story = {
  args: {
    status: "evidence-pending",
    goal,
    criteria: [
      { ...baseCriteria[0], state: "met" },
      { ...baseCriteria[1], state: "pending", note: "Running the story gate…" },
      { ...baseCriteria[2], state: "pending" },
    ],
  },
};

export const CriteriaFailed: Story = {
  args: {
    status: "criteria-failed",
    goal,
    criteria: [
      { ...baseCriteria[0], state: "met" },
      {
        ...baseCriteria[1],
        state: "failed",
        note: "TopicChipsBar threw a console error on the Empty story.",
      },
      { ...baseCriteria[2], state: "met" },
    ],
  },
};

export const CriteriaMet: Story = {
  args: {
    status: "criteria-met",
    goal,
    criteria: baseCriteria,
  },
};
