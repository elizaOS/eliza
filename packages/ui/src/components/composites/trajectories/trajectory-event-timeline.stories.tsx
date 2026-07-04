/**
 * Storybook states for the Trajectory Event Timeline trajectory visualizer
 * used by run-detail and evidence surfaces.
 */
import type { Meta, StoryObj } from "@storybook/react";
import {
  TrajectoryEventTimeline,
  type TrajectoryTimelineEvent,
} from "./trajectory-event-timeline";

const sampleEvents: readonly TrajectoryTimelineEvent[] = [
  {
    id: "evt-1",
    type: "plan",
    label: "Plan generated",
    stage: "plan",
    status: "success",
    timestampLabel: "12:04:11",
    description:
      "Drafted a 4-step plan to summarize the inbox and reply to Alex.",
  },
  {
    id: "evt-2",
    type: "tool",
    label: "search_inbox",
    stage: "tool",
    status: "running",
    timestampLabel: "12:04:13",
    description: "Querying Gmail for messages from the last 24 hours.",
    meta: "model: claude-opus-4 · attempt 1/3",
  },
  {
    id: "evt-3",
    type: "tool",
    label: "draft_reply",
    stage: "tool",
    status: "queued",
    timestampLabel: "12:04:14",
  },
  {
    id: "evt-4",
    type: "tool",
    label: "send_email",
    stage: "act",
    status: "skipped",
    timestampLabel: "12:04:15",
    description: "Skipped: waiting on user approval.",
  },
];

const meta = {
  title: "Composites/Trajectories/TrajectoryEventTimeline",
  component: TrajectoryEventTimeline,
  tags: ["autodocs"],
  argTypes: {
    heading: { control: "text" },
    emptyLabel: { control: "text" },
    events: { control: false },
  },
  args: {
    heading: "Trajectory",
    events: sampleEvents,
  },
} satisfies Meta<typeof TrajectoryEventTimeline>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Empty: Story = {
  args: {
    heading: "Trajectory",
    events: [],
    emptyLabel: "No events captured yet for this run.",
  },
};

export const AllSuccess: Story = {
  args: {
    heading: "Completed run",
    events: [
      {
        id: "ok-1",
        type: "plan",
        label: "Plan generated",
        stage: "plan",
        status: "success",
        timestampLabel: "08:00:01",
      },
      {
        id: "ok-2",
        type: "tool",
        label: "fetch_calendar",
        stage: "tool",
        status: "success",
        timestampLabel: "08:00:02",
        description: "Loaded 3 events for today.",
      },
      {
        id: "ok-3",
        type: "respond",
        label: "Reply sent",
        stage: "act",
        status: "success",
        timestampLabel: "08:00:04",
      },
    ],
  },
};

export const WithFailure: Story = {
  args: {
    heading: "Failed run",
    events: [
      {
        id: "f-1",
        type: "tool",
        label: "search_inbox",
        stage: "tool",
        status: "success",
        timestampLabel: "09:12:00",
      },
      {
        id: "f-2",
        type: "tool",
        label: "send_email",
        stage: "act",
        status: "failure",
        timestampLabel: "09:12:03",
        description: "SMTP timeout after 30s.",
        meta: "retries: 3 · last error: ETIMEDOUT",
      },
    ],
  },
};

export const SingleInfoEvent: Story = {
  args: {
    heading: "System note",
    events: [
      {
        id: "i-1",
        type: "info",
        label: "Run started",
        status: "info",
        timestampLabel: "Just now",
        description: "Awaiting first tool call.",
      },
    ],
  },
};
