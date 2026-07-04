import type { Meta, StoryObj } from "@storybook/react";
import type { DesktopLauncherEntry } from "../../state/desktop-tray-launcher";
import { TrayLauncher } from "./TrayLauncher";

// TrayLauncher normally reads its rows from the desktop launcher store the host
// populates from DESKTOP_VIEW_WINDOWS. Stories pass `entries` directly and a
// no-op `onSelect` so they render deterministically without the desktop host.
const CATALOG: DesktopLauncherEntry[] = [
  { itemId: "tray-show-window", label: "Open Eliza", icon: "home" },
  { itemId: "tray-open-view-tutorial", label: "Tutorial", icon: "tutorial" },
  { itemId: "tray-open-view-help", label: "Help", icon: "help" },
  { itemId: "tray-open-view-chat", label: "Messages", icon: "chat" },
  { itemId: "tray-open-view-character", label: "Character", icon: "character" },
  { itemId: "tray-open-view-documents", label: "Knowledge", icon: "documents" },
  { itemId: "tray-open-view-settings", label: "Settings", icon: "settings" },
  {
    itemId: "tray-open-view-background",
    label: "Background",
    icon: "background",
  },
];

const meta = {
  title: "Shell/TrayLauncher",
  component: TrayLauncher,
  tags: ["autodocs"],
  parameters: { layout: "centered" },
  args: {
    entries: CATALOG,
    onSelect: (itemId: string) => {
      // eslint-disable-next-line no-console -- story action log
      console.log("[TrayLauncher story] select", itemId);
    },
  },
  decorators: [
    (Story) => (
      <div className="w-[360px] rounded-md bg-card p-3">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof TrayLauncher>;

export default meta;
type Story = StoryObj<typeof meta>;

export const FullCatalog: Story = {};

export const OpenElizaOnly: Story = {
  args: {
    entries: [{ itemId: "tray-show-window", label: "Open Eliza", icon: "home" }],
  },
};

export const Empty: Story = {
  args: { entries: [] },
};
