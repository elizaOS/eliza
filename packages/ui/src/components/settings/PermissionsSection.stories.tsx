import type { Meta, StoryObj } from "@storybook/react";
import { withMockApp } from "../../storybook/mock-providers.helpers";
import { PermissionsSection } from "./PermissionsSection";

/**
 * `PermissionsSection` renders the platform-appropriate permissions UI
 * (web / mobile / desktop). In Storybook the web variant is selected, which
 * surfaces the streaming-permissions card plus any boot-config blocker cards.
 *
 * Its data hooks fetch through the API client (which has no backend here), so
 * the desktop-style sub-views resolve to their loading / empty states — a valid
 * and useful render.
 */
const meta = {
  title: "Settings/PermissionsSection",
  component: PermissionsSection,
  tags: ["autodocs"],
  decorators: [withMockApp],
  parameters: {
    layout: "padded",
  },
} satisfies Meta<typeof PermissionsSection>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Default render in a roomy settings-style container. */
export const Default: Story = {
  render: () => (
    <div className="max-w-3xl space-y-6">
      <PermissionsSection />
    </div>
  ),
};

/** Narrow container to exercise the responsive stacking of headers and rows. */
export const Narrow: Story = {
  render: () => (
    <div className="max-w-sm space-y-6">
      <PermissionsSection />
    </div>
  ),
};

/** Rendered inside a bordered card, mirroring its placement in Settings. */
export const InSettingsCard: Story = {
  render: () => (
    <div className="max-w-3xl rounded-lg border border-border/40 bg-card p-6">
      <h2 className="mb-4 text-base font-semibold text-txt">
        Permissions &amp; Capabilities
      </h2>
      <PermissionsSection />
    </div>
  ),
};
