/** Demonstrates the native top-layer dialog adapter used by imperative hosts. */

import type { Meta, StoryObj } from "@storybook/react";
import { NativeDialog } from "./native-dialog";

const meta = {
  title: "Primitives/NativeDialog",
  component: NativeDialog,
  tags: ["autodocs"],
  args: {
    open: true,
    "aria-label": "Contact Eliza",
    children: "Native dialog content",
  },
} satisfies Meta<typeof NativeDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Open: Story = {};
