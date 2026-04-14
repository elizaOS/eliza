import type { Meta, StoryObj } from "@storybook/react";
import {
  Bot,
  CheckCircle2,
  MessageSquareText,
  Route,
  Wrench,
} from "lucide-react";
import { useState } from "react";

import {
  type PipelineStageId,
  TrajectoryLlmCallCard,
  TrajectoryPipelineGraph,
  TrajectorySidebarItem,
} from "../index";

const pipelineNodes = [
  {
    id: "input",
    label: "Input",
    callCount: 1,
    status: "active" as const,
    icon: MessageSquareText,
  },
  {
    id: "should_respond",
    label: "Respond",
    callCount: 1,
    status: "active" as const,
    icon: CheckCircle2,
  },
  {
    id: "plan",
    label: "Plan",
    callCount: 2,
    status: "active" as const,
    icon: Route,
  },
  {
    id: "actions",
    label: "Actions",
    callCount: 3,
    status: "active" as const,
    icon: Wrench,
  },
  {
    id: "evaluators",
    label: "Eval",
    callCount: 1,
    status: "skipped" as const,
    icon: Bot,
  },
];

const meta = {
  title: "Composites/Trajectories",
  component: TrajectoryPipelineGraph,
  tags: ["autodocs"],
  parameters: {
    layout: "centered",
  },
} satisfies Meta<typeof TrajectoryPipelineGraph>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Overview: Story = {
  render: () => {
    const [activeStageId, setActiveStageId] = useState<PipelineStageId | null>(
      "actions",
    );

    return (
      <div className="w-[min(100vw-2rem,72rem)] space-y-5">
        <TrajectoryPipelineGraph
          nodes={pipelineNodes}
          activeStageId={activeStageId}
          onStageClick={setActiveStageId}
        />

        <div className="grid gap-4 lg:grid-cols-[320px_minmax(0,1fr)]">
          <div className="space-y-3">
            <TrajectorySidebarItem
              active
              callCount={3}
              durationLabel="842 ms"
              sourceLabel="wallet.send"
              sourceColor="#36b37e"
              statusLabel="completed"
              statusColor="#36b37e"
              title="Send wallet summary"
              tokenLabel="1.8k tokens"
            />
            <TrajectorySidebarItem
              callCount={1}
              durationLabel="211 ms"
              sourceLabel="browser.open"
              sourceColor="#60a5fa"
              statusLabel="blocked"
              statusColor="#f59e0b"
              title="Open approval docs"
              tokenLabel="612 tokens"
            />
          </div>

          <TrajectoryLlmCallCard
            callLabel="Call"
            copyLabel="Copy"
            costLabel="Cost"
            costValue="$0.0024"
            inputLabel="Input"
            inputLinesLabel="4 lines"
            latencyLabel="Latency"
            maxLabel="Max"
            maxValue="1,024"
            model="gpt-5.4"
            onCopy={() => undefined}
            outputLabel="Output"
            outputLinesLabel="6 lines"
            purposeLabel="Purpose"
            response={`Three approvals are pending.\n\n1. wallet.send requires confirmation.\n2. browser.open_external is blocked.\n3. retry after policy sync completes.`}
            systemCollapseLabel="Collapse"
            systemExpandLabel="Expand"
            systemLabel="System"
            systemLinesLabel="12 lines"
            systemPrompt={`You are the app.\nKeep updates short.\nPrioritize actions that unblock the user.\nReference approval state when tool execution is gated.`}
            systemPromptButtonLabel="System prompt"
            temperatureLabel="Temp"
            temperatureValue="0.2"
            tokensLabel="Tokens"
            totalTokensValue="1,842"
            tokenBreakdownMeta="1,220 input / 622 output"
            userPrompt={`Summarize the current wallet approvals queue.\nMention any blocked browser actions.\nKeep it to 3 bullet points.`}
            tags={["wallet", "browser", "approvals"]}
          />
        </div>
      </div>
    );
  },
};
