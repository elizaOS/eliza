/**
 * Exercises the shipped Messages presentation across SMS role and send states.
 * Snapshot fixtures do not send messages or certify Android bridge behavior.
 */
import type { Meta, StoryObj } from "@storybook/react";
import { MessagesSpatialView } from "../../../../../plugins/plugin-messages/src/components/MessagesSpatialView";
import { SpatialSurface } from "../../spatial";

const meta = {
  title: "Plugin views/Messages",
  component: MessagesSpatialView,
  decorators: [
    (Story) => (
      <SpatialSurface>
        <Story />
      </SpatialSurface>
    ),
  ],
  args: {
    snapshot: {
      threads: [],
      selectedThreadId: null,
      composeAddress: "",
      composeBody: "",
      ownsSmsRole: true,
      smsRoleHolder: null,
      loading: false,
      sending: false,
      error: null,
    },
  },
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof MessagesSpatialView>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Empty: Story = {};
export const Loading: Story = {
  args: { snapshot: { ...meta.args.snapshot, loading: true } },
};
export const LoadError: Story = {
  args: {
    snapshot: {
      ...meta.args.snapshot,
      error: "Messages could not load. Check device access and retry.",
    },
  },
};
export const RoleRequired: Story = {
  args: {
    snapshot: {
      ...meta.args.snapshot,
      ownsSmsRole: false,
      smsRoleHolder: "com.android.messaging",
    },
  },
};
export const Composing: Story = {
  args: {
    snapshot: {
      ...meta.args.snapshot,
      composeAddress: "+15550100",
      composeBody: "Meet at 10?",
    },
  },
};
export const Sending: Story = {
  args: {
    snapshot: {
      ...meta.args.snapshot,
      composeAddress: "+15550100",
      composeBody: "Meet at 10?",
      sending: true,
    },
  },
};

const received = {
  id: "story-message",
  threadId: "story-thread",
  address: "+15550100",
  body: "Meet at 10?",
  date: Date.UTC(2026, 8, 6, 9),
  type: 1,
  read: false,
};
export const Populated: Story = {
  args: {
    snapshot: {
      ...meta.args.snapshot,
      selectedThreadId: "story-thread",
      composeAddress: "+15550100",
      threads: [
        {
          id: "story-thread",
          address: "+15550100",
          messages: [received],
          lastMessage: received,
          unreadCount: 1,
        },
      ],
    },
  },
};
