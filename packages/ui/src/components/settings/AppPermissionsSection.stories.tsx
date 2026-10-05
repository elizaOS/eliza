import type { Meta, StoryObj } from "@storybook/react";
import { client } from "../../api/client";
import { withMockApp } from "../../storybook/mock-providers.helpers";
import { AppPermissionsSection } from "./AppPermissionsSection";

const meta = {
  title: "Settings/AppPermissionsSection",
  component: AppPermissionsSection,
  tags: ["autodocs"],
  decorators: [withMockApp],
  parameters: { layout: "padded" },
  beforeEach: () => {
    const list = client.listAppPermissions;
    client.listAppPermissions = async () => [];
    return () => {
      client.listAppPermissions = list;
    };
  },
} satisfies Meta<typeof AppPermissionsSection>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const NarrowColumn: Story = {
  render: () => (
    <div className="max-w-sm">
      <AppPermissionsSection />
    </div>
  ),
};
