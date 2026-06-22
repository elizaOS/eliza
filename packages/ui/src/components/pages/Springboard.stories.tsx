import type { Meta, StoryObj } from "@storybook/react";
import type { ViewEntry } from "../../hooks/view-catalog";
import { Springboard } from "./Springboard";

function entry(id: string, label: string, icon: string): ViewEntry {
  return {
    key: `view:${id}`,
    id,
    label,
    icon,
    hasHero: false,
    modality: "gui",
    state: "loaded",
    kind: "view",
    viewKind: "release",
  } as ViewEntry;
}

const VIEWS: ViewEntry[] = [
  entry("chat", "Chat", "MessageSquare"),
  entry("character", "Character", "UserRound"),
  entry("automations", "Automations", "Clock"),
  entry("camera", "Camera", "ImageIcon"),
  entry("wallet", "Wallet", "Wallet"),
  entry("contacts", "Contacts", "UsersRound"),
  entry("memories", "Memories", "BrainCircuit"),
  entry("database", "Database", "Database"),
  entry("phone", "Phone", "Phone"),
  entry("settings", "Settings", "Monitor"),
];

const meta: Meta<typeof Springboard> = {
  title: "Pages/Springboard",
  component: Springboard,
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div className="h-[640px] w-full bg-bg">
        <Story />
      </div>
    ),
  ],
};
export default meta;

type Story = StoryObj<typeof Springboard>;

export const Default: Story = {
  args: { entries: VIEWS, onLaunch: () => {} },
};

export const ManyPages: Story = {
  args: {
    entries: Array.from({ length: 28 }, (_, i) =>
      entry(`view-${i}`, `View ${i + 1}`, "LayoutGrid"),
    ),
    onLaunch: () => {},
  },
};
