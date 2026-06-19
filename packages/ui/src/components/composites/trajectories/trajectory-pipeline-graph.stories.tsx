import type { Meta, StoryObj } from "@storybook/react";
import {
  Brain,
  ClipboardList,
  Inbox,
  MessageSquare,
  Sparkles,
} from "lucide-react";
import {
  type PipelineNode,
  TrajectoryPipelineGraph,
} from "./trajectory-pipeline-graph";

const baseNodes: PipelineNode[] = [
  {
    id: "input",
    label: "Input",
    callCount: 1,
    status: "active",
    icon: Inbox,
  },
  {
    id: "should_respond",
    label: "Should Respond",
    callCount: 1,
    status: "active",
    icon: MessageSquare,
  },
  {
    id: "plan",
    label: "Plan",
    callCount: 2,
    status: "active",
    icon: ClipboardList,
  },
  {
    id: "actions",
    label: "Actions",
    callCount: 3,
    status: "active",
    icon: Sparkles,
  },
  {
    id: "evaluators",
    label: "Evaluators",
    callCount: 1,
    status: "active",
    icon: Brain,
  },
];

const meta = {
  title: "Composites/Trajectories/TrajectoryPipelineGraph",
  component: TrajectoryPipelineGraph,
  tags: ["autodocs"],
  argTypes: {
    activeStageId: {
      control: "select",
      options: [
        null,
        "input",
        "should_respond",
        "plan",
        "actions",
        "evaluators",
      ],
    },
    onStageClick: { action: "stage-clicked" },
  },
  args: {
    nodes: baseNodes,
    activeStageId: null,
    onStageClick: () => {},
  },
} satisfies Meta<typeof TrajectoryPipelineGraph>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const StageSelected: Story = {
  args: {
    activeStageId: "actions",
  },
};

export const WithSkippedStages: Story = {
  args: {
    nodes: [
      { ...baseNodes[0] },
      { ...baseNodes[1], status: "skipped", callCount: 0 },
      { ...baseNodes[2], status: "skipped", callCount: 0 },
      { ...baseNodes[3] },
      { ...baseNodes[4] },
    ],
  },
};

export const WithErrorStage: Story = {
  args: {
    nodes: [
      { ...baseNodes[0] },
      { ...baseNodes[1] },
      { ...baseNodes[2] },
      { ...baseNodes[3], status: "error", callCount: 1 },
      { ...baseNodes[4], status: "skipped", callCount: 0 },
    ],
    activeStageId: "actions",
  },
};

export const HighCallCounts: Story = {
  args: {
    nodes: baseNodes.map((node, i) => ({
      ...node,
      callCount: i === 0 ? 1 : (i + 1) * 7,
    })),
  },
};
