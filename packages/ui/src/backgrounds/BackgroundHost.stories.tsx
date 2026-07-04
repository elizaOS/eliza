/**
 * Storybook stories for the static BackgroundHost (see block below).
 */
import type { Meta, StoryObj } from "@storybook/react";
import { BackgroundHost } from "./BackgroundHost";

/**
 * `BackgroundHost` renders the static, solid shell background. It is absolutely
 * positioned (`inset: 0`), so each story wraps it in a relatively-positioned
 * frame to make it visible.
 */
const meta = {
  title: "Backgrounds/BackgroundHost",
  component: BackgroundHost,
  tags: ["autodocs"],
  argTypes: {
    className: { control: "text" },
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
        <div
          style={{
            position: "relative",
            zIndex: 1,
            padding: 16,
            color: "#fff",
            fontFamily: "system-ui, sans-serif",
            fontWeight: 600,
          }}
        >
          Shell content sits above the background
        </div>
      </div>
    ),
  ],
} satisfies Meta<typeof BackgroundHost>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * Default: solid background sourced from the theme's `--background` token,
 * falling back to the sky-blue color when the variable is unset.
 */
export const Default: Story = {};

/**
 * With no theme variable defined, the sky-blue fallback color is used. The
 * decorator frame here intentionally leaves `--background` unset.
 */
export const SkyFallback: Story = {
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
};

/**
 * Theme override: a custom `--background` token is provided on the frame, so the
 * host resolves to that color instead of the fallback.
 */
export const ThemedBackground: Story = {
  decorators: [
    (Story) => (
      <div
        style={
          {
            position: "relative",
            width: "100%",
            height: 320,
            borderRadius: 12,
            overflow: "hidden",
            ["--background" as string]: "#0f172a",
          } as React.CSSProperties
        }
      >
        <Story />
      </div>
    ),
  ],
};

/**
 * Extra class names pass through to the root element (alongside the inline
 * positioning styles the component always applies).
 */
export const WithClassName: Story = {
  args: {
    className: "",
  },
};
