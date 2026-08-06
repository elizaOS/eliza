/** Voice-profile lifecycle management states with real client-shaped fixtures. */
import type { Meta, StoryObj } from "@storybook/react";
import { userEvent } from "storybook/test";
import { VoiceProfilesClient } from "../../api/client-voice-profiles";
import { assert, waitForTestId } from "../../storybook/home-widget-decorator";
import { VoiceProfileSection } from "./VoiceProfileSection";

const profilesClient = new VoiceProfilesClient({
  fetch: async <T,>(): Promise<T> => ({ profiles: [] }) as T,
});

const profiles = [
  {
    id: "owner",
    entityId: "entity-owner",
    displayName: "Owner",
    relationshipLabel: null,
    isOwner: true,
    embeddingCount: 4,
    firstHeardAtMs: 1,
    lastHeardAtMs: 4,
    cohort: "owner" as const,
    source: "first-run" as const,
    retentionDays: null,
    samplePreviewUri: null,
    samples: [
      {
        id: "owner-1",
        durationMs: 1800,
        recordedAt: "2026-08-01T10:00:00.000Z",
      },
      {
        id: "owner-2",
        durationMs: 2200,
        recordedAt: "2026-08-02T10:00:00.000Z",
      },
    ],
  },
  {
    id: "unknown-a",
    entityId: null,
    displayName: "Unknown speaker",
    relationshipLabel: null,
    isOwner: false,
    embeddingCount: 3,
    firstHeardAtMs: 2,
    lastHeardAtMs: 5,
    cohort: "unknown" as const,
    source: "auto-clustered" as const,
    retentionDays: 30,
    samplePreviewUri: null,
    samples: [
      {
        id: "unknown-1",
        durationMs: 950,
        recordedAt: "2026-08-03T10:00:00.000Z",
      },
      {
        id: "unknown-2",
        durationMs: 1450,
        recordedAt: "2026-08-04T10:00:00.000Z",
      },
      {
        id: "unknown-3",
        durationMs: 2100,
        recordedAt: "2026-08-05T10:00:00.000Z",
      },
    ],
  },
];

const meta = {
  title: "Settings/VoiceProfileSection",
  component: VoiceProfileSection,
  parameters: { layout: "padded" },
  args: {
    profilesClient,
    initialProfiles: profiles,
    className: "max-w-2xl",
  },
} satisfies Meta<typeof VoiceProfileSection>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Resting: Story = {};

export const LifecycleExpanded: Story = {
  play: async ({ canvasElement }) => {
    const manage = canvasElement.querySelector(
      '[data-testid="voice-profile-manage-unknown-a"]',
    );
    assert(manage instanceof HTMLButtonElement, "manage control renders");
    await userEvent.click(manage);
    await waitForTestId(canvasElement, "voice-profile-lifecycle-unknown-a");
  },
};
