/** Recorded-data fixtures only; these stories never send a prompt. */
import type { Meta, StoryObj } from "@storybook/react";
import type {
  TrajectoryDetailResult,
  TrajectoryRecord,
} from "../../api/client-types-cloud";
import { DeveloperReplyDetails, DeveloperTrace } from "./DeveloperWorkspace";

const record = {
  id: "example-turn",
  agentId: "example-agent",
  source: "client_chat",
  status: "completed",
  roomId: "example-room",
  entityId: null,
  conversationId: null,
  startTime: 1000,
  endTime: 2800,
  durationMs: 1800,
  llmCallCount: 2,
  providerAccessCount: 0,
  totalPromptTokens: 20000,
  totalCompletionTokens: 70,
  createdAt: "2026-09-09T00:00:00Z",
  updatedAt: "2026-09-09T00:00:02Z",
  metadata: { traceId: "example-trace", messageId: "example-message" },
} satisfies TrajectoryRecord;
const detail = {
  trajectory: record,
  payloadsIncluded: false,
  providerAccesses: [],
  llmCalls: [
    {
      id: "call-1",
      trajectoryId: record.id,
      stepId: "step-1",
      timestamp: 1000,
      model: "qwen-3.8-27b",
      provider: "cerebras",
      purpose: "reply",
      actionType: "REPLY",
      temperature: 0.7,
      maxTokens: 2048,
      latencyMs: 1450,
      createdAt: record.createdAt,
      promptTokens: 20000,
      completionTokens: 70,
      cacheReadInputTokens: 8000,
    },
  ],
} satisfies TrajectoryDetailResult;

const meta = {
  title: "Developer/Recorded trace",
  component: DeveloperTrace,
  args: { record, detail },
  decorators: [
    (Story) => (
      <div className="max-w-[560px] bg-card p-4 text-txt">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof DeveloperTrace>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Completed: Story = {};
/** Summary-only fixture; live expanded evidence is verified against the local app. */
export const ChatReply: Story = {
  render: () => (
    <article className="developer-message developer-message-assistant">
      <p>Notes is open.</p>
      <DeveloperReplyDetails record={record} />
    </article>
  ),
};
export const UnknownUsage: Story = {
  args: {
    detail: {
      ...detail,
      llmCalls: [
        {
          ...detail.llmCalls[0],
          promptTokens: undefined,
          completionTokens: undefined,
          cacheReadInputTokens: undefined,
        },
      ],
    },
  },
};
export const BackgroundMemory: Story = {
  args: { record: { ...record, source: "background_memory" } },
};
