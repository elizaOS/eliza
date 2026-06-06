import type { Meta, StoryObj } from "@storybook/react";
import { CharacterPersonalityTimeline } from "./CharacterPersonalityTimeline";
import type { CharacterPersonalityHistoryItem } from "./character-hub-types";

const baseEntries: CharacterPersonalityHistoryItem[] = [
  {
    id: "1",
    field: "tone",
    scope: "global",
    timestamp: "2026-05-30T14:22:00.000Z",
    actor: "shaw",
    summary: "Made replies a bit warmer when greeting new users.",
    reason: "Feedback from beta cohort skewed toward 'too curt'.",
    beforeText: "Hello. How can I help?",
    afterText: "Hey! Happy to help — what are you working on?",
    relatedEntityName: null,
  },
  {
    id: "2",
    field: "humor",
    scope: "user",
    timestamp: "2026-05-29T09:10:00.000Z",
    actor: "auto-learning",
    summary: "Picked up that this user enjoys dry humor.",
    reason: null,
    beforeText: null,
    afterText: null,
    relatedEntityName: "alice@example.com",
  },
  {
    id: "3",
    field: "style.formality",
    scope: "auto",
    timestamp: "2026-05-28T18:45:00.000Z",
    actor: null,
    summary: null,
    reason: "Conversation context shifted to casual chat.",
    beforeText: "formal",
    afterText: "casual",
    relatedEntityName: null,
  },
];

const meta = {
  title: "Character/CharacterPersonalityTimeline",
  component: CharacterPersonalityTimeline,
  tags: ["autodocs"],
  argTypes: {
    entries: { control: "object" },
  },
  args: {
    entries: baseEntries,
  },
} satisfies Meta<typeof CharacterPersonalityTimeline>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Empty: Story = {
  args: {
    entries: [],
  },
};

export const SingleEntry: Story = {
  args: {
    entries: [baseEntries[0]],
  },
};

export const WithoutDiffs: Story = {
  args: {
    entries: [
      {
        id: "a",
        field: "interests",
        scope: "global",
        timestamp: "2026-06-01T12:00:00.000Z",
        actor: "shaw",
        summary: "Added 'electronics' to known interests.",
        reason: null,
        beforeText: null,
        afterText: null,
        relatedEntityName: null,
      },
      {
        id: "b",
        field: "interests",
        scope: "user",
        timestamp: "2026-06-02T08:30:00.000Z",
        actor: null,
        summary: "User mentioned a new hobby: woodworking.",
        reason: "Detected during weekend chat.",
        beforeText: null,
        afterText: null,
        relatedEntityName: "bob@example.com",
      },
    ],
  },
};

export const LongHistory: Story = {
  args: {
    entries: Array.from({ length: 8 }, (_, i) => ({
      id: `entry-${i}`,
      field: ["tone", "humor", "style.formality", "interests"][i % 4],
      scope: (["auto", "global", "user"] as const)[i % 3],
      timestamp: new Date(2026, 4, 20 + i, 10, 0, 0).toISOString(),
      actor: i % 2 === 0 ? "auto-learning" : "shaw",
      summary: `Adjustment ${i + 1} applied to the persona profile.`,
      reason: i % 3 === 0 ? "Periodic recalibration." : null,
      beforeText: i % 2 === 0 ? "previous value" : null,
      afterText: i % 2 === 0 ? "updated value" : null,
      relatedEntityName: i % 4 === 0 ? "team-channel" : null,
    })),
  },
};
