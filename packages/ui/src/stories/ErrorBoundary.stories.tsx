import type { Meta, StoryObj } from "@storybook/react";
import React, { useState } from "react";
import { ErrorBoundary } from "../components/ui/error-boundary";

const meta: Meta<typeof ErrorBoundary> = {
  title: "Molecules/ErrorBoundary",
  component: ErrorBoundary,
};
export default meta;

function BrokenChild({ shouldThrow }: { shouldThrow: boolean }) {
  if (shouldThrow) throw new Error("Simulated component error for demo");
  return (
    <div className="p-4 border rounded-md">✅ Child rendered successfully</div>
  );
}

export const NoError: StoryObj = {
  render: () => (
    <ErrorBoundary>
      <BrokenChild shouldThrow={false} />
    </ErrorBoundary>
  ),
};

export const DefaultFallback: StoryObj = {
  render: () => (
    <ErrorBoundary>
      <BrokenChild shouldThrow={true} />
    </ErrorBoundary>
  ),
};

export const CustomFallback: StoryObj = {
  render: () => (
    <ErrorBoundary
      fallback={(error, reset) => (
        <div className="p-4 border border-red-300 bg-red-50 rounded-md text-center">
          <p className="text-sm font-bold text-red-600 mb-2">Custom Fallback</p>
          <p className="text-xs text-red-500 mb-3">{error.message}</p>
          <button
            type="button"
            className="px-3 py-1.5 text-xs border rounded hover:bg-red-100 transition-colors"
            onClick={reset}
          >
            Reset
          </button>
        </div>
      )}
    >
      <BrokenChild shouldThrow={true} />
    </ErrorBoundary>
  ),
};
