/**
 * Storybook coverage for the app permissions settings panel as it settles from
 * backend fetch into empty/error and responsive states.
 */
import type { Meta, StoryObj } from "@storybook/react";
import { withMockApp } from "../../storybook/mock-providers.helpers";
import { AppPermissionsSection } from "./AppPermissionsSection";

/**
 * `AppPermissionsSection` fetches the app permission list from the API on mount
 * (`client.listAppPermissions()`). In Storybook there is no backend, so the
 * panel renders its loading spinner first and then settles into the error /
 * empty state once the request rejects — both are valid, useful states to see.
 */
const meta = {
  title: "Settings/AppPermissionsSection",
  component: AppPermissionsSection,
  tags: ["autodocs"],
  decorators: [withMockApp],
  parameters: { layout: "padded" },
} satisfies Meta<typeof AppPermissionsSection>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * Default mount. Shows the loading spinner, then the error/empty state once the
 * (backend-less) fetch settles.
 */
export const Default: Story = {};

/** Same component constrained to a narrow column to exercise the responsive layout. */
export const NarrowColumn: Story = {
  render: () => (
    <div className="max-w-sm">
      <AppPermissionsSection />
    </div>
  ),
};
