import type { Meta, StoryObj } from "@storybook/react";
import { CopyButton } from "../components/ui/copy-button";

const meta: Meta<typeof CopyButton> = {
  title: "Atoms/CopyButton",
  component: CopyButton,
};
export default meta;

export const Default: StoryObj = { args: { value: "0xABCD…1234" } };
