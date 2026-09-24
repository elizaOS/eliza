/** Empty, active-session, joining, and failed meeting-join states. */
import { MeetingJoinBar } from "./MeetingJoinBar";
import { assert } from "../../storybook/home-widget-decorator";
import { type MeetingSession } from "@elizaos/core/meetings";
import { type Meta } from "@storybook/react";
import { type StoryObj } from "@storybook/react";
const activeMeeting: MeetingSession = {
    id: "meeting-story",
    platform: "zoom",
    meetingUrl: "https://app.zoom.us/wc/1234567890/join",
    nativeMeetingId: "1234567890",
    botName: "Eliza",
    status: "active",
    requestedAt: Date.UTC(2026, 7, 2, 18, 0, 0),
    participants: [],
};
const meta = {
    title: "Transcripts/MeetingJoinBar",
    component: MeetingJoinBar,
    parameters: { layout: "padded" },
    args: { activeMeetings: [], onJoin: () => { }, onStop: () => { } },
} satisfies Meta<typeof MeetingJoinBar>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Empty: Story = {};
export const Joining: Story = { args: { joining: true } };
export const Failed: Story = {
    args: { error: "The meeting bot could not join. Check the link and retry." },
};
export const ActiveSession: Story = {
    args: { activeMeetings: [activeMeeting] },
    play: async ({ canvasElement }) => {
        const session = canvasElement.querySelector('[data-testid="active-meeting-meeting-story"]');
        assert(session instanceof HTMLElement, "active meeting row renders");
        assert(session.textContent?.includes("In meeting"), "status is visible");
    },
};
