/** Grouped settings navigation with canonical section medallions and labels. */
import type { Meta, StoryObj } from "@storybook/react";
import { Bell, Palette, Shield } from "lucide-react";
import { assert } from "../../storybook/home-widget-decorator";
import { SettingsHubList } from "./SettingsHubList";
import type { GroupedSettingsSections } from "./settings-sections";

const EmptySection = () => null;
const grouped: GroupedSettingsSections = [
  {
    group: "system",
    label: "App",
    items: [
      {
        id: "appearance",
        label: "settings.appearance",
        defaultLabel: "Appearance",
        icon: Palette,
        tone: "accent",
        hue: "accent",
        titleKey: "settings.appearance",
        defaultTitle: "Appearance",
        group: "system",
        Component: EmptySection,
      },
      {
        id: "notifications",
        label: "settings.notifications",
        defaultLabel: "Notifications",
        icon: Bell,
        tone: "warn",
        hue: "amber",
        titleKey: "settings.notifications",
        defaultTitle: "Notifications",
        group: "system",
        Component: EmptySection,
      },
    ],
  },
  {
    group: "security",
    label: "Privacy & security",
    items: [
      {
        id: "permissions",
        label: "settings.permissions",
        defaultLabel: "Permissions",
        icon: Shield,
        tone: "neutral",
        hue: "slate",
        titleKey: "settings.permissions",
        defaultTitle: "Permissions",
        group: "security",
        Component: EmptySection,
      },
    ],
  },
];

let selected = "";
const meta = {
  title: "Settings/SettingsHubList",
  component: SettingsHubList,
  parameters: { layout: "padded" },
  args: {
    grouped,
    label: (_key: string, fallback: string) => fallback,
    onSelect: (id: string) => {
      selected = id;
    },
  },
} satisfies Meta<typeof SettingsHubList>;

export default meta;
type Story = StoryObj<typeof meta>;

export const GroupedSections: Story = {
  play: async ({ canvasElement }) => {
    selected = "";
    const appearance = canvasElement.querySelector(
      '[data-testid="settings-hub-row-appearance"]',
    );
    assert(
      appearance instanceof HTMLButtonElement,
      "appearance navigation row renders",
    );
    appearance.click();
    assert(selected === "appearance", "row selects its settings section");
  },
};
