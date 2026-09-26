/** Synthetic recorded evidence only; these reader stories make no runtime or model requests. */
import type { Meta, StoryObj } from "@storybook/react";
import type {
  TrajectoryDetailResult,
  TrajectoryLlmCall,
  TrajectoryRecord,
} from "../../api/client-types-cloud";
import { MockAppProvider } from "../../storybook/mock-providers";
import { TrajectoryReader } from "./DeveloperReader";

const record = {
  id: "synthetic-reader-run",
  agentId: "synthetic-agent",
  entityId: null,
  roomId: "synthetic-room",
  conversationId: null,
  source: "client_chat",
  status: "completed",
  startTime: 1000,
  endTime: 2800,
  durationMs: 1800,
  llmCallCount: 2,
  providerAccessCount: 1,
  totalPromptTokens: 1700,
  totalCompletionTokens: 120,
  createdAt: "2026-09-15T12:00:00Z",
  updatedAt: "2026-09-15T12:00:02Z",
  metadata: { messageId: "synthetic-request" },
} satisfies TrajectoryRecord;
const systemPrompt =
  "# Character\nYou are Eliza. Preserve the complete user request.\n\n# Current-turn policy\nRead the requested note. Do not create or change records.\n\n# Completion\nReport only what the recorded tool result establishes.\n";
const call = {
  id: "synthetic-planner",
  trajectoryId: record.id,
  stepId: "planner-step",
  timestamp: 1100,
  model: "synthetic-model",
  provider: "synthetic-provider",
  purpose: "action_planner",
  actionType: "NOTES_READ",
  temperature: 0,
  maxTokens: 0,
  maxTokensOmitted: true,
  latencyMs: 600,
  createdAt: record.createdAt,
  promptTokens: 1200,
  completionTokens: 45,
  cacheReadInputTokens: 800,
  systemPrompt,
  messages: [
    {
      role: "user",
      content: "Read the note named Weekend plan. Keep its wording exactly.",
    },
  ],
  userPrompt: `${systemPrompt}\nRead the note named Weekend plan. Keep its wording exactly.`,
  tools: {
    NOTES_READ: {
      description: "Read one saved note.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
        additionalProperties: false,
      },
    },
  },
  toolChoice: "required",
  providerOptions: { temperature: 0 },
  response: JSON.stringify({
    toolCalls: [{ name: "NOTES_READ", args: { id: "note-weekend" } }],
  }),
  toolCalls: [{ name: "NOTES_READ", args: { id: "note-weekend" } }],
} satisfies TrajectoryLlmCall;
const detail = {
  trajectory: record,
  payloadsIncluded: true,
  llmCalls: [
    call,
    {
      ...call,
      id: "synthetic-completion",
      stepId: "completion-step",
      timestamp: 2200,
      purpose: "evaluation",
      actionType: "FINISH",
      promptTokens: 500,
      completionTokens: 75,
      cacheReadInputTokens: 0,
      latencyMs: 300,
      systemPrompt:
        "evaluator_stage:\nCheck the requested outcome against recorded evidence.",
      messages: [
        {
          role: "user",
          content:
            "Recorded NOTES_READ result: Saturday: walk by the river. Sunday: read.",
        },
      ],
      userPrompt:
        "Recorded NOTES_READ result: Saturday: walk by the river. Sunday: read.",
      tools: {},
      toolCalls: [],
      toolChoice: "none",
      response: JSON.stringify({
        decision: "FINISH",
        success: true,
        messageToUser: "Saturday: walk by the river. Sunday: read.",
      }),
    },
  ],
  providerAccesses: [
    {
      id: "synthetic-provider",
      trajectoryId: record.id,
      stepId: "context-step",
      timestamp: 1000,
      createdAt: record.createdAt,
      providerName: "SAVED_NOTES",
      purpose: "state_composition",
      query: {
        message: "Read the note named Weekend plan.",
        roomId: record.roomId,
      },
      data: {
        text: "# Available note context\nWeekend plan — note-weekend\nProvider evidence is intermediate context; inspect the model input separately.",
      },
    },
  ],
  semanticStages: [
    {
      schemaVersion: 1,
      stageId: "planner-step",
      kind: "planner",
      startedAt: 1100,
      endedAt: 1750,
      latencyMs: 650,
      payload: {
        model: {
          modelType: "ACTION_PLANNER",
          messages: call.messages,
          response: call.response,
        },
      },
    },
    {
      schemaVersion: 1,
      stageId: "note-read-step",
      kind: "tool",
      startedAt: 1800,
      endedAt: 1900,
      latencyMs: 100,
      payload: {
        tool: {
          name: "NOTES_READ",
          args: { id: "note-weekend" },
          result: {
            success: true,
            title: "Weekend plan",
            content: "Saturday: walk by the river. Sunday: read.",
          },
        },
      },
    },
  ],
} satisfies TrajectoryDetailResult;

const meta = {
  title: "Developer/Run reader",
  component: TrajectoryReader,
  args: { detail },
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <MockAppProvider>
        <div className="developer-reader bg-card p-4 text-txt">
          <Story />
        </div>
      </MockAppProvider>
    ),
  ],
} satisfies Meta<typeof TrajectoryReader>;
export default meta;
type Story = StoryObj<typeof meta>;

export const CompleteEvidence: Story = {};
export const UnknownPayloadsAndUsage: Story = {
  args: {
    detail: {
      ...detail,
      trajectory: { ...record, llmCallCount: 1 },
      providerAccesses: [],
      semanticStages: [],
      llmCalls: [
        {
          ...call,
          systemPrompt: undefined,
          messages: undefined,
          userPrompt: undefined,
          tools: undefined,
          response: undefined,
          toolCalls: undefined,
          promptTokens: undefined,
          completionTokens: undefined,
          cacheReadInputTokens: undefined,
        },
      ],
    },
  },
};
export const RecordedEmptyValues: Story = {
  args: {
    detail: {
      ...detail,
      trajectory: {
        ...record,
        llmCallCount: 1,
        totalPromptTokens: 0,
        totalCompletionTokens: 0,
      },
      providerAccesses: [],
      semanticStages: [],
      llmCalls: [
        {
          ...call,
          systemPrompt: "",
          messages: [],
          userPrompt: "",
          tools: {},
          response: "",
          toolCalls: [],
          promptTokens: 0,
          completionTokens: 0,
          cacheReadInputTokens: 0,
        },
      ],
    },
  },
};
export const NoRecordedCalls: Story = {
  args: {
    detail: {
      trajectory: {
        ...record,
        llmCallCount: 0,
        providerAccessCount: 0,
        totalPromptTokens: 0,
        totalCompletionTokens: 0,
      },
      payloadsIncluded: true,
      llmCalls: [],
      providerAccesses: [],
      semanticStages: [],
    },
  },
};
