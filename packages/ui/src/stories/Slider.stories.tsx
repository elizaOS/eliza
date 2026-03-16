import type { Meta, StoryObj } from "@storybook/react";
import { Slider } from "../components/ui/slider";

const meta: Meta<typeof Slider> = { title: "Atoms/Slider", component: Slider };
export default meta;

export const Default: StoryObj = {
  args: { defaultValue: [70], max: 100, step: 1 },
};
