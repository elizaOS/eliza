/** Word-synced and untimed transcript reading states. */
import type { Transcript } from "@elizaos/shared/transcripts";
import type { Meta, StoryObj } from "@storybook/react";
import { assert } from "../../storybook/home-widget-decorator";
import { TranscriptBody } from "./TranscriptBody";
import { TRANSCRIPT_STORY_FIXTURE } from "./transcript-story-fixtures";

let seekTarget = -1;
const meta = {
  title: "Transcripts/TranscriptBody",
  component: TranscriptBody,
  parameters: { layout: "padded" },
  args: {
    transcript: TRANSCRIPT_STORY_FIXTURE,
    currentTimeMs: 1_100,
    onSeekMs: (ms: number) => {
      seekTarget = ms;
    },
  },
} satisfies Meta<typeof TranscriptBody>;

export default meta;
type Story = StoryObj<typeof meta>;

export const WordSynced: Story = {
  play: async ({ canvasElement }) => {
    seekTarget = -1;
    const active = canvasElement.querySelector('[data-active="true"]');
    assert(
      active instanceof HTMLButtonElement,
      "active transcript word renders",
    );
    assert(
      active.textContent === "review",
      "playback position highlights review",
    );
    active.click();
    assert(seekTarget === 950, "word activation seeks to its start");
  },
};

const untimedTranscript: Transcript = {
  ...TRANSCRIPT_STORY_FIXTURE,
  segments: [
    {
      id: "untimed",
      speakerLabel: "Maya",
      startMs: 0,
      endMs: 4_000,
      text: "This transcript is available without word-level timing.",
      words: [],
    },
  ],
};

export const Untimed: Story = {
  args: { transcript: untimedTranscript, currentTimeMs: 1_000 },
};
