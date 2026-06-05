import type { Meta, StoryObj } from "@storybook/react";
import { mockApp } from "../../storybook/mock-providers.helpers";
import { SystemWarningBanner } from "./SystemWarningBanner";

// The banner reads systemWarnings / dismissSystemWarning from useApp() and
// returns null when systemWarnings is empty, so each story forces it visible by
// overriding those fields on the mock AppContext via mockApp({ ... }).
const meta = {
  title: "Shell/SystemWarningBanner",
  component: SystemWarningBanner,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof SystemWarningBanner>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A single broadcast warning with the dismiss control. */
export const Default: Story = {
  decorators: [
    mockApp({
      systemWarnings: [
        "Model provider rate limit reached — responses may be delayed.",
      ],
      dismissSystemWarning: () => {},
    }),
  ],
};

/** Several stacked warnings, newest last. */
export const Multiple: Story = {
  decorators: [
    mockApp({
      systemWarnings: [
        "WebSocket reconnecting — live updates paused.",
        "Local inference model is still downloading (62%).",
        "Voice input unavailable: microphone permission denied.",
      ],
      dismissSystemWarning: () => {},
    }),
  ],
};

/** A long message that truncates within the banner. */
export const LongMessage: Story = {
  decorators: [
    mockApp({
      systemWarnings: [
        "The agent runtime reported an unexpected error while loading the @elizaos/plugin-companion view bundle and has fallen back to a degraded mode; some features may be missing until the next restart.",
      ],
      dismissSystemWarning: () => {},
    }),
  ],
};
