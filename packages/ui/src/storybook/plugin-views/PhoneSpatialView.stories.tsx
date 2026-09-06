/**
 * Exercises the shipped Phone presentation in resolved device states.
 * These snapshots are visual fixtures; native call permission and delivery
 * must be verified on Android rather than inferred from these stories.
 */
import type { Meta, StoryObj } from "@storybook/react";
import { PhoneSpatialView } from "../../../../../plugins/plugin-phone/src/components/PhoneSpatialView";
import { SpatialSurface } from "../../spatial";

const meta = {
  title: "Plugin views/Phone",
  component: PhoneSpatialView,
  decorators: [
    (Story) => (
      <SpatialSurface>
        <Story />
      </SpatialSurface>
    ),
  ],
  args: {
    snapshot: {
      callReady: true,
      dialed: "",
      calls: [],
      loading: false,
      error: null,
    },
  },
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof PhoneSpatialView>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Empty: Story = {};
export const Loading: Story = {
  args: {
    snapshot: { ...meta.args.snapshot, loading: true, callReady: false },
  },
};
export const LoadError: Story = {
  args: {
    snapshot: {
      ...meta.args.snapshot,
      callReady: false,
      error:
        "Phone status is unavailable. Retry after checking device permissions.",
    },
  },
};
export const Denied: Story = {
  args: {
    snapshot: {
      ...meta.args.snapshot,
      callReady: false,
      error: "Phone access is needed. Grant it in device settings, then retry.",
    },
  },
};
export const Populated: Story = {
  args: {
    snapshot: {
      ...meta.args.snapshot,
      dialed: "+15550100",
      calls: [
        {
          id: "incoming",
          name: "Ada",
          number: "+15550100",
          when: "9:00 AM",
          direction: "incoming",
        },
        {
          id: "missed",
          name: "Grace",
          number: "+15550200",
          when: "Yesterday",
          direction: "missed",
        },
      ],
    },
  },
};
