/** Desktop shortcut recording and native-registration failure states. */
import type { Meta, StoryObj } from "@storybook/react";
import type { ComponentType } from "react";
import { userEvent } from "storybook/test";
import type { ElectrobunRendererRpc } from "../../bridge";
import { withMockApp } from "../../storybook/mock-providers.helpers";
import { DesktopShortcutsSection } from "./DesktopShortcutsSection";

function withShortcutRegistration(result: { success: boolean } | null) {
  return (Story: ComponentType) => {
    const rpc: ElectrobunRendererRpc = {
      request: {
        desktopRegisterShortcut: async () => result,
      },
      onMessage: () => undefined,
      offMessage: () => undefined,
    };
    Object.assign(window, { __ELIZA_ELECTROBUN_RPC__: rpc });
    return <Story />;
  };
}

const meta = {
  title: "Settings/DesktopShortcutsSection",
  component: DesktopShortcutsSection,
  tags: ["autodocs"],
  decorators: [withMockApp],
  parameters: { layout: "padded" },
} satisfies Meta<typeof DesktopShortcutsSection>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Resting shortcut row with successful native registration available. */
export const Resting: Story = {
  decorators: [withShortcutRegistration({ success: true })],
};

/** Keyboard capture mode before a replacement combo is committed. */
export const Recording: Story = {
  decorators: [withShortcutRegistration({ success: true })],
  play: async ({ canvasElement }) => {
    const record = canvasElement.querySelector<HTMLButtonElement>(
      '[data-agent-id="shortcut-push-to-talk-record"]',
    );
    if (!record) throw new Error("Shortcut record control did not render");
    await userEvent.click(record);
  },
};

/** Version-skew error after a native host omits shortcut registration. */
export const NativeMethodUnavailable: Story = {
  decorators: [withShortcutRegistration(null)],
  play: async ({ canvasElement }) => {
    const record = canvasElement.querySelector<HTMLButtonElement>(
      '[data-agent-id="shortcut-push-to-talk-record"]',
    );
    if (!record) throw new Error("Shortcut record control did not render");
    await userEvent.click(record);
    await userEvent.keyboard("{Meta>}{Shift>}X{/Shift}{/Meta}");
  },
};

/** Native registration explicitly rejects the captured replacement. */
export const ReplacementRejected: Story = {
  decorators: [withShortcutRegistration({ success: false })],
  play: async ({ canvasElement }) => {
    const record = canvasElement.querySelector<HTMLButtonElement>(
      '[data-agent-id="shortcut-push-to-talk-record"]',
    );
    if (!record) throw new Error("Shortcut record control did not render");
    await userEvent.click(record);
    await userEvent.keyboard("{Meta>}{Shift>}X{/Shift}{/Meta}");
  },
};
