/** Desktop launch-at-login Settings states backed by the native RPC contract. */
import type { Meta, StoryObj } from "@storybook/react";
import type { ComponentType } from "react";
import type { ElectrobunRendererRpc } from "../../bridge";
import { withMockApp } from "../../storybook/mock-providers.helpers";
import { DesktopIntegrationSection } from "./DesktopIntegrationSection";

function withDesktopAutoLaunch(
  enabled: boolean | null | "loading",
  mutationSucceeds = true,
) {
  return (Story: ComponentType) => {
    const rpc: ElectrobunRendererRpc = {
      request:
        enabled === null
          ? {}
          : {
              desktopGetAutoLaunchStatus: async () =>
                enabled === "loading"
                  ? await new Promise<never>(() => undefined)
                  : { enabled, openAsHidden: false },
              desktopSetAutoLaunch: async () => {
                if (!mutationSucceeds) {
                  throw new Error("Desktop service unavailable");
                }
              },
            },
      onMessage: () => undefined,
      offMessage: () => undefined,
    };
    Object.assign(window, { __ELIZA_ELECTROBUN_RPC__: rpc });
    return <Story />;
  };
}

const meta = {
  title: "Settings/DesktopIntegrationSection",
  component: DesktopIntegrationSection,
  tags: ["autodocs"],
  decorators: [withMockApp],
  parameters: { layout: "padded" },
} satisfies Meta<typeof DesktopIntegrationSection>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Native authority reports that launch at sign-in is enabled. */
export const Enabled: Story = {
  decorators: [withDesktopAutoLaunch(true)],
};

/** Stable loading state while the native authority has not responded. */
export const Loading: Story = {
  decorators: [withDesktopAutoLaunch("loading")],
};

/** Visible, retryable error after a transient native mutation failure. */
export const MutationFailed: Story = {
  decorators: [withDesktopAutoLaunch(false, false)],
  play: async ({ canvasElement }) => {
    const toggle = canvasElement.querySelector<HTMLButtonElement>(
      '[data-agent-id="general-launch-on-login"]',
    );
    if (!toggle) throw new Error("Launch at sign-in control did not render");
    await import("storybook/test").then(({ userEvent }) =>
      userEvent.click(toggle),
    );
  },
};

/** Version-skew state where the native status RPC is unavailable. */
export const NativeMethodUnavailable: Story = {
  decorators: [withDesktopAutoLaunch(null)],
};
