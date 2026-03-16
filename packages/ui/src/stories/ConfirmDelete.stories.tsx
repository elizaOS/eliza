import type { Meta, StoryObj } from "@storybook/react";
import { ConfirmDelete } from "../components/ui/confirm-delete";

const meta: Meta<typeof ConfirmDelete> = {
  title: "Molecules/ConfirmDelete",
  component: ConfirmDelete,
};
export default meta;

export const Default: StoryObj = { args: { onConfirm: () => {} } };
