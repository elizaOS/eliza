/** Storybook fixture driving the ErrorBoundary fallback via a child that throws on render; also feeds the story-gate render check. */
import type { Meta, StoryObj } from "@storybook/react";
import { ErrorBoundary } from "./error-boundary";

// A child that throws on render, to exercise the caught-error fallback.
function Boom(): never {
  throw new Error("Simulated render failure in a child component.");
}

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

/** A throwing child is caught and the default fallback (with retry) is shown. */
export const CaughtError: Story = {
  args: { children: <Boom /> },
};

/** Custom heading + retry labels on the fallback. */
export const CustomLabels: Story = {
  args: {
    children: <Boom />,
    errorLabel: "This view crashed",
    retryLabel: "Reload view",
  },
};
