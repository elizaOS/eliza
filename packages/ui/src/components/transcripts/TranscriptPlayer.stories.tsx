/** Read-only transcript player state when no recording is available. */
import type { Meta, StoryObj } from "@storybook/react";
import { TranscriptPlayer } from "./TranscriptPlayer";
import { TRANSCRIPT_STORY_FIXTURE } from "./transcript-story-fixtures";

const meta = {
  title: "Transcripts/TranscriptPlayer",
  component: TranscriptPlayer,
  parameters: { layout: "padded" },
  args: { transcript: TRANSCRIPT_STORY_FIXTURE },
} satisfies Meta<typeof TranscriptPlayer>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ReadOnly: Story = {};
