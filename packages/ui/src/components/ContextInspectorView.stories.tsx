/** Storybook entry for the authenticated, redacted context inspector surface. */

import type { Meta, StoryObj } from "@storybook/react";
import ContextInspectorView from "./ContextInspectorView";

const meta: Meta<typeof ContextInspectorView> = {
  title: "Pages/ContextInspectorView",
  component: ContextInspectorView,
};

export default meta;

type Story = StoryObj<typeof ContextInspectorView>;

export const Default: Story = {};
