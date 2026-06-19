import type { Meta, StoryObj } from "@storybook/react";
import type { DesktopTab } from "../../hooks/useDesktopTabs";
import { DesktopTabBar } from "./DesktopTabBar";

/**
 * DesktopTabBar only renders when `isElectrobunRuntime()` is true. The decorator
 * stamps `window.__electrobunWindowId` so the component renders in Storybook.
 */
function withElectrobunRuntime(
  Story: () => React.JSX.Element,
): React.JSX.Element {
  if (typeof window !== "undefined") {
    (
      window as Window & { __electrobunWindowId?: number }
    ).__electrobunWindowId = 1;
  }
  return <Story />;
}

const sampleTabs: DesktopTab[] = [
  {
    viewId: "chat",
    label: "Chat",
    path: "/chat",
    icon: "message-circle",
    pinned: true,
  },
  {
    viewId: "tasks",
    label: "Tasks",
    path: "/tasks",
    icon: "list-checks",
    pinned: true,
  },
  {
    viewId: "wallet",
    label: "Wallet",
    path: "/wallet",
    icon: "wallet",
    pinned: false,
  },
];

const meta = {
  title: "Desktop/DesktopTabBar",
  component: DesktopTabBar,
  tags: ["autodocs"],
  decorators: [withElectrobunRuntime],
  argTypes: {
    activeViewId: { control: "text" },
    onTabClick: { action: "tabClick" },
    onTabClose: { action: "tabClose" },
    onOpenViewManager: { action: "openViewManager" },
  },
  args: {
    tabs: sampleTabs,
    activeViewId: "chat",
    onTabClick: () => {},
    onTabClose: () => {},
    onOpenViewManager: () => {},
  },
} satisfies Meta<typeof DesktopTabBar>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const SingleTab: Story = {
  args: {
    tabs: [
      {
        viewId: "chat",
        label: "Chat",
        path: "/chat",
        icon: "message-circle",
        pinned: true,
      },
    ],
    activeViewId: "chat",
  },
};

export const ManyTabs: Story = {
  args: {
    tabs: [
      ...sampleTabs,
      {
        viewId: "feed",
        label: "Feed",
        path: "/feed",
        icon: "newspaper",
        pinned: true,
      },
      {
        viewId: "calendar",
        label: "Calendar",
        path: "/calendar",
        icon: "calendar",
        pinned: true,
      },
      {
        viewId: "long-name",
        label: "Some Very Long View Name That Truncates",
        path: "/long",
        icon: "file",
        pinned: false,
      },
    ],
    activeViewId: "feed",
  },
};

export const NoActiveTab: Story = {
  args: {
    activeViewId: null,
  },
};
