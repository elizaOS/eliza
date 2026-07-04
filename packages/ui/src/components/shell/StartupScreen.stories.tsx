import type { Meta, StoryObj } from "@storybook/react";
import { mockApp, withMockApp } from "../../storybook/mock-providers.helpers";
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

// The loading splash is delay-gated (STARTUP_SPLASH_DELAY_MS): it renders null
// for the first ~220ms, and the story gate screenshots shortly after mount and
// hard-fails NEW blank renders. Wait for the splash to appear before the gate
// captures. Hand-rolled poll (no @storybook/test in this repo); setTimeout
// only — the story-gate determinism shim freezes Date.now(), so wall-clock
// deadlines never advance.
const waitForSplash = async ({
  canvasElement,
}: {
  canvasElement: HTMLElement;
}) => {
  for (let i = 0; i < 40; i += 1) {
    if (canvasElement.querySelector('[data-testid="startup-shell-loading"]')) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("startup splash did not appear after the delay gate");
};

/**
 * The wired `StartupScreen`. With no backend in Storybook the startup
 * coordinator never advances, so it renders its loading (boot) state.
 */
export const Default: Story = { play: waitForSplash };

// The presentational shell drives every startup state from its `view` prop,
// so the variants below exercise each branch directly.
function ShellStory({ view }: { view: StartupShellView }) {
  return <StartupShell view={view} onRetry={() => {}} />;
}

export const Loading: Story = {
  play: waitForSplash,
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

export const Pairing: Story = {
  // PairingView reads the pairing slice via useAppSelectorShallow — give it a
  // concrete shape (an empty code, pairing enabled) so it renders the entry
  // form. Without it the mock Proxy returns its `noop` fallback for the unset
  // `pairingCodeInput` string, and `pairingCodeInput.trim()` throws.
  decorators: [
    mockApp({
      pairingEnabled: true,
      pairingExpiresAt: null,
      pairingCodeInput: "",
      pairingError: null,
      pairingBusy: false,
    }),
  ],
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
