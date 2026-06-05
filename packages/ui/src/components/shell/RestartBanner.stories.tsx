import type { Meta, StoryObj } from "@storybook/react";
import { mockApp } from "../../storybook/mock-providers.helpers";
import { RestartBanner } from "./RestartBanner";

// RestartBanner reads everything from useApp() and renders null unless a restart
// is pending (`pendingRestart`) and the banner is undismissed
// (`restartBannerDismissed === false`). The copy is driven by
// `pendingRestartReasons` (string[]): one reason -> single line, many -> a count,
// none -> generic "restart required". Each story forces the visible branch via
// mockApp() and supplies a readable `t` so the i18n keys render as real copy.
const restartCopy = (
  key: string,
  opts?: { defaultValue?: string; reason?: string; count?: number },
) => {
  if (key === "restartbanner.SingleReasonPending")
    return `Restart needed: ${opts?.reason}`;
  if (key === "restartbanner.MultipleReasonsPending")
    return `${opts?.count} changes need a restart`;
  if (key === "restartbanner.RestartRequired") return "Restart required";
  if (key === "restartbanner.Later") return "Later";
  if (key === "restartbanner.RestartNow") return "Restart now";
  if (key === "restartbanner.Restarting") return "Restarting…";
  return opts?.defaultValue ?? key;
};

const meta = {
  title: "Shell/RestartBanner",
  component: RestartBanner,
  tags: ["autodocs"],
  parameters: { layout: "fullscreen" },
  decorators: [
    mockApp({
      t: restartCopy,
      pendingRestart: true,
      restartBannerDismissed: false,
      pendingRestartReasons: ["OpenAI API key"],
    }),
  ],
} satisfies Meta<typeof RestartBanner>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A single config change is awaiting a restart. */
export const SingleReason: Story = {
  decorators: [
    mockApp({
      t: restartCopy,
      pendingRestart: true,
      restartBannerDismissed: false,
      pendingRestartReasons: ["OpenAI API key"],
    }),
  ],
};

/** Several pending changes collapse into a count. */
export const MultipleReasons: Story = {
  decorators: [
    mockApp({
      t: restartCopy,
      pendingRestart: true,
      restartBannerDismissed: false,
      pendingRestartReasons: [
        "OpenAI API key",
        "Discord token",
        "Model provider",
      ],
    }),
  ],
};

/** Pending with no specific reason — generic "restart required" copy. */
export const NoReason: Story = {
  decorators: [
    mockApp({
      t: restartCopy,
      pendingRestart: true,
      restartBannerDismissed: false,
      pendingRestartReasons: [],
    }),
  ],
};

/** Mid-restart: the action button is disabled and shows progress copy. */
export const Restarting: Story = {
  decorators: [
    mockApp({
      t: restartCopy,
      pendingRestart: true,
      restartBannerDismissed: false,
      pendingRestartReasons: ["OpenAI API key"],
      // Never-resolving so the button stays in its disabled "Restarting…" state.
      triggerRestart: () => new Promise<void>(() => {}),
    }),
  ],
  play: async ({ canvasElement }) => {
    canvasElement
      .querySelector<HTMLButtonElement>("button:last-of-type")
      ?.click();
  },
};
