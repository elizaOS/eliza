/**
 * Storybook states for the AgentActivityBox chat component used by message
 * rendering, attachments, and composer surfaces.
 */
import type { Meta, StoryObj } from "@storybook/react";
import type { CodingAgentSession } from "../../api/client-types-cloud";
import { mockApp } from "../../storybook/mock-providers.helpers";
import { AgentActivityBox } from "./AgentActivityBox";

const session = (
  overrides: Partial<CodingAgentSession> & { sessionId: string },
): CodingAgentSession => ({
  agentType: "claude",
  label: "feature/auth",
  originalTask: "Wire up OAuth callback",
  workdir: "/repo/packages/auth",
  status: "active",
  decisionCount: 0,
  autoResolvedCount: 0,
  ...overrides,
});

const meta = {
  title: "Chat/AgentActivityBox",
  component: AgentActivityBox,
  tags: ["autodocs"],
  decorators: [mockApp({})],
  args: {
    onSessionClick: () => {},
  },
  parameters: {
    layout: "padded",
  },
} satisfies Meta<typeof AgentActivityBox>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Single active session with explicit lastActivity text. */
export const Default: Story = {
  args: {
    sessions: [
      session({
        sessionId: "s1",
        label: "feature/auth",
        lastActivity: "Editing src/auth/oauth.ts",
      }),
    ],
  },
};

/** Multiple sessions in different states, exercising all status dots/colors. */
export const Mixed: Story = {
  args: {
    sessions: [
      session({
        sessionId: "s1",
        label: "feature/auth",
        status: "active",
        lastActivity: "Editing src/auth/oauth.ts",
      }),
      session({
        sessionId: "s2",
        label: "refactor/api",
        status: "tool_running",
        toolDescription: "ripgrep",
      }),
      session({
        sessionId: "s3",
        label: "bugfix/race",
        status: "blocked",
      }),
      session({
        sessionId: "s4",
        label: "spike/dnd",
        status: "error",
      }),
    ],
  },
};

/** Tool-running session with no lastActivity — falls back to deriveActivity. */
export const ToolRunning: Story = {
  args: {
    sessions: [
      session({
        sessionId: "s1",
        label: "refactor/api",
        status: "tool_running",
        toolDescription: "ripgrep search for 'getUser' across packages/core",
      }),
    ],
  },
};

/** Blocked — waiting for input. */
export const Blocked: Story = {
  args: {
    sessions: [
      session({
        sessionId: "s1",
        label: "bugfix/race",
        status: "blocked",
      }),
    ],
  },
};

/** Error state — danger color text. */
export const Errored: Story = {
  args: {
    sessions: [
      session({
        sessionId: "s1",
        label: "spike/dnd",
        status: "error",
        lastActivity: "Build failed: type error in widgets.ts",
      }),
    ],
  },
};

/** Empty sessions array — renders nothing (component returns null). */
export const Empty: Story = {
  args: {
    sessions: [],
  },
};
