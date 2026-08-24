/** Storybook fixture driving the ErrorBoundary fallback via a child that throws on render; also feeds the story-gate render check. */
import type { Meta, StoryObj } from "@storybook/react";
import { ErrorBoundary, ErrorBoundaryFallback } from "./error-boundary";

const meta = {
  title: "Primitives/ErrorBoundary",
  component: ErrorBoundary,
  tags: ["autodocs"],
  parameters: { layout: "centered" },
  argTypes: {
    errorLabel: { control: "text" },
    retryLabel: { control: "text" },
  },
} satisfies Meta<typeof ErrorBoundary>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Healthy children render through untouched. */
export const Healthy: Story = {
  args: {
    children: <div className="text-txt">Everything is rendering fine.</div>,
  },
};
