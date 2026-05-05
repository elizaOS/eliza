import type { Meta, StoryObj } from "@storybook/react";
import { ErrorBoundary } from "../components/ui/error-boundary";

const meta = {
  title: "UI/ErrorBoundary",
  component: ErrorBoundary,
  tags: ["autodocs"],
} satisfies Meta<typeof ErrorBoundary>;

export default meta;
type Story = StoryObj<typeof meta>;

const SafeChild = () => (
  <div className="p-4 border rounded-md">This content renders normally.</div>
);

const BrokenChild = () => {
  throw new Error("Something broke while rendering this component!");
};

export const Normal: Story = {
  render: () => (
    <ErrorBoundary>
      <SafeChild />
    </ErrorBoundary>
  ),
};

export const WithError: Story = {
  render: () => (
    <ErrorBoundary>
      <BrokenChild />
    </ErrorBoundary>
  ),
};

export const CustomFallback: Story = {
  render: () => (
    <ErrorBoundary
      fallback={(error, reset) => (
        <div className="rounded-md border border-[color:var(--accent)]/45 bg-[color:rgba(var(--accent-rgb,240,185,11),0.08)] p-6 text-center">
          <p className="mb-2 font-semibold text-[color:var(--text-strong,var(--text,#111827))]">
            Custom Error UI
          </p>
          <p className="mb-4 text-sm text-[color:var(--muted-strong,var(--muted,#4b5563))]">
            {error.message}
          </p>
          <button
            type="button"
            className="px-3 py-1 text-sm border rounded-md"
            onClick={reset}
          >
            Reset
          </button>
        </div>
      )}
    >
      <BrokenChild />
    </ErrorBoundary>
  ),
};

export const CustomLabels: Story = {
  render: () => (
    <ErrorBoundary errorLabel="Oops!" retryLabel="Retry">
      <BrokenChild />
    </ErrorBoundary>
  ),
};
