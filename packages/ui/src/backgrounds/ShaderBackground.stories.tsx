/**
 * Storybook stories for the animated ShaderBackground (see block below).
 */
import type { Meta, StoryObj } from "@storybook/react";
import { ShaderBackground } from "./ShaderBackground";

/**
 * `ShaderBackground` is the animated shader field for the unified app
 * background — a flat base color with a gentle rim pulse. It is `fixed
 * inset-0`, so each story wraps it in a relatively-positioned frame.
 */
const meta = {
  title: "Backgrounds/ShaderBackground",
  component: ShaderBackground,
  tags: ["autodocs"],
  argTypes: {
    color: { control: "color" },
  },
  decorators: [
    (Story) => (
      <div
        style={{
          position: "relative",
          width: "100%",
          height: 320,
          borderRadius: 12,
          overflow: "hidden",
        }}
      >
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ShaderBackground>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Default warm-orange shader (the prior home look). */
export const Default: Story = {};

/** A neutral stone color drives the same gentle rim pulse. */
export const Stone: Story = { args: { color: "#57534e" } };

/** A vivid color shows the rim glow inherits the chosen hue. */
export const Rose: Story = { args: { color: "#e11d48" } };
