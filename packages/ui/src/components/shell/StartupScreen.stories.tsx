import type { Meta, StoryObj } from "@storybook/react";
import { withMockApp } from "../../storybook/mock-providers.helpers";
import { StartupScreen } from "./StartupScreen";
import { StartupShell } from "./StartupShell";
import type { StartupShellView } from "./startup-shell-types";

const meta = {
  title: "Shell/StartupScreen",
  component: StartupScreen,
  parameters: { layout: "fullscreen" },
  decorators: [withMockApp],
} satisfies Meta<typeof StartupScreen>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * The wired `StartupScreen`. With no backend in Storybook the startup
 * coordinator never advances, so it renders its loading (boot) state.
 */
export const Default: Story = {};

// The presentational shell drives every startup state from its `view` prop,
// so the variants below exercise each branch directly.
function ShellStory({ view }: { view: StartupShellView }) {
  return (
    <StartupShell
      view={view}
      firstRun={
        <div className="flex h-full w-full items-center justify-center text-center text-lg font-medium">
          Welcome to elizaOS — let's set up your agent.
        </div>
      }
      onRetry={() => {}}
    />
  );
}

export const Loading: Story = {
  render: () => (
    <ShellStory
      view={{
        kind: "loading",
        phase: "polling-backend",
        status: "Connecting to backend...",
      }}
    />
  ),
};

export const FirstRun: Story = {
  render: () => <ShellStory view={{ kind: "first-run" }} />,
};

export const Pairing: Story = {
  render: () => <ShellStory view={{ kind: "pairing" }} />,
};

export const ErrorState: Story = {
  render: () => (
    <ShellStory
      view={{
        kind: "error",
        error: {
          reason: "backend-unreachable",
          message:
            "Could not reach the agent backend at http://localhost:7777.",
          phase: "starting-backend",
          detail: "ECONNREFUSED 127.0.0.1:7777",
        },
      }}
    />
  ),
};
