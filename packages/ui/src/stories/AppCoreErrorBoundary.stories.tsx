import { ErrorBoundary } from "@elizaos/app-core/components";
import type { Meta, StoryObj } from "@storybook/react";

const meta: Meta<typeof ErrorBoundary> = {
  title: "App Core/ErrorBoundary",
  component: ErrorBoundary,
};
export default meta;

function BrokenChild() {
  throw new Error("Something went wrong in this component!");
}

export const CaughtError: StoryObj = {
  render: () => (
    <div className="w-[500px] h-[300px] border rounded-lg overflow-hidden">
      <ErrorBoundary>
        <BrokenChild />
      </ErrorBoundary>
    </div>
  ),
};

export const NormalChildren: StoryObj = {
  render: () => (
    <div className="w-[500px] border rounded-lg overflow-hidden">
      <ErrorBoundary>
        <div className="p-8 text-center">
          <h3 className="font-semibold mb-2">Everything is fine</h3>
          <p className="text-sm text-muted">
            This content renders normally inside the ErrorBoundary.
          </p>
        </div>
      </ErrorBoundary>
    </div>
  ),
};
