/** Storybook stories for ToolCallEventLog — success, running, failure, long-args-and-result, and minimal-fields states. */

import type { Meta, StoryObj } from "@storybook/react";
import type { NativeToolCallEvent } from "../../api/client-types-cloud";
import { ToolCallEventLog } from "./ToolCallEventLog";

const baseEvent: NativeToolCallEvent = {
  id: "evt_001",
  trajectoryId: "traj_abc",
  stepId: "step_1",
  stage: "actions",
  timestamp: Date.now(),
  type: "tool_result",
  callId: "call_001",
  actionName: "search_documents",
  args: { query: "quarterly revenue", limit: 5 },
  result: {
    matches: [
      { title: "Q3 Earnings Report", score: 0.92 },
      { title: "Q2 Earnings Report", score: 0.81 },
    ],
  },
  status: "completed",
  success: true,
  durationMs: 342,
};

const meta = {
  title: "ToolEvents/ToolCallEventLog",
  component: ToolCallEventLog,
  tags: ["autodocs"],
  argTypes: {
    className: { control: "text" },
    event: { control: "object" },
  },
  args: {
    event: baseEvent,
  },
} satisfies Meta<typeof ToolCallEventLog>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Success: Story = {};

export const Running: Story = {
  args: {
    event: {
      ...baseEvent,
      id: "evt_002",
      type: "tool_call",
      status: "running",
      success: undefined,
      result: undefined,
      durationMs: undefined,
      actionName: "fetch_weather",
      args: { location: "San Francisco, CA" },
    },
  },
};

export const Failure: Story = {
  args: {
    event: {
      ...baseEvent,
      id: "evt_003",
      type: "tool_error",
      status: "failed",
      success: false,
      actionName: "send_email",
      args: { to: "user@example.com", subject: "Hello" },
      result: undefined,
      error: "SMTP connection refused: timeout after 30s",
      durationMs: 30000,
    },
  },
};

export const LongArgsAndResult: Story = {
  args: {
    event: {
      ...baseEvent,
      id: "evt_004",
      actionName: "generate_summary",
      stage: "message_handler",
      args: {
        text: "Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(
          12,
        ),
        style: "concise",
        maxTokens: 256,
      },
      result: {
        summary:
          "The document covers quarterly performance, growth metrics, and forward-looking guidance across five operating segments. ".repeat(
            6,
          ),
      },
      durationMs: 1284,
    },
  },
};

export const MinimalFields: Story = {
  args: {
    event: {
      id: "evt_005",
      type: "tool_call",
      toolName: "ping",
    },
  },
};
