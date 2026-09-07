/**
 * Exercises the shipped Messages presentation across SMS role and send states.
 * Snapshot fixtures do not send messages or certify Android bridge behavior.
 */
import type { Meta, StoryObj } from "@storybook/react";
import { expect, fn, userEvent, within } from "storybook/test";
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

const shortViewportAction = fn();

/** A landscape app body must scroll without compressing status or actions. */
export const ShortViewport: Story = {
  args: {
    snapshot: {
      ...meta.args.snapshot,
      ownsSmsRole: false,
      smsRoleHolder: "com.android.messaging",
    },
    onAction: shortViewportAction,
  },
  render: (args) => (
    <div
      data-testid="messages-viewport"
      style={{ width: "100%", maxWidth: 844, height: 258, overflow: "hidden" }}
    >
      <SpatialSurface>
        <MessagesSpatialView {...args} />
      </SpatialSurface>
    </div>
  ),
  play: async ({ canvasElement, args }) => {
    shortViewportAction.mockClear();
    const canvas = within(canvasElement);
    const frame = canvas.getByTestId("messages-viewport");
    const status = canvas.getByText("bridge:com.android.messaging");
    const role = canvas.getByRole("button", { name: "Set default SMS" });
    const statusRect = status.getBoundingClientRect();
    await expect(statusRect.height).toBeGreaterThan(0);
    await expect(statusRect.bottom).toBeLessThanOrEqual(
      role.getBoundingClientRect().top,
    );
    await userEvent.click(role);
    await expect(args.onAction).toHaveBeenCalledWith("request-sms-role");
    const refresh = canvas.getByRole("button", { name: "Refresh messages" });
    let scroller = refresh.parentElement;
    while (
      scroller &&
      scroller !== frame &&
      !(
        ["auto", "scroll"].includes(getComputedStyle(scroller).overflowY) &&
        scroller.scrollHeight > scroller.clientHeight
      )
    ) {
      scroller = scroller.parentElement;
    }
    if (!scroller || scroller === frame)
      throw new Error("Short Messages view has no reachable scroll container");
    scroller.scrollTop = scroller.scrollHeight;
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => resolve()),
    );
    const control = refresh.getBoundingClientRect();
    const viewport = frame.getBoundingClientRect();
    await expect(control.top).toBeGreaterThanOrEqual(viewport.top);
    await expect(control.bottom).toBeLessThanOrEqual(viewport.bottom);
    const hit = document.elementFromPoint(
      control.x + control.width / 2,
      control.y + control.height / 2,
    );
    await expect(hit && refresh.contains(hit)).toBeTruthy();
    await userEvent.click(refresh);
    await expect(args.onAction).toHaveBeenCalledWith("refresh");
    await expect(
      canvas.getByRole("button", { name: "Send SMS" }),
    ).toBeDisabled();
  },
};
