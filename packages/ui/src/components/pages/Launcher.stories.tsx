import type { Meta, StoryObj } from "@storybook/react";
import type { ViewEntry } from "../../hooks/view-catalog";
import { assert } from "../../storybook/home-widget-decorator";
import { Launcher } from "./Launcher";

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

// Module-scoped capture for the launch play (no @storybook/test in repo).
let launchedId: string | null = null;

const meta: Meta<typeof Launcher> = {
  title: "Pages/Launcher",
  component: Launcher,
  parameters: { layout: "fullscreen" },
  args: { onLaunch: () => {} },
  decorators: [
    (Story) => (
      <div className="h-[640px] w-full bg-bg">
        <Story />
      </div>
    ),
  ],
};
export default meta;

type Story = StoryObj<typeof Launcher>;

export const Default: Story = {
  args: {
    entries: VIEWS,
    pageGroups: [VIEWS.map((v) => v.id)],
  },
};

/** Multiple curated pages — each group renders as its own launcher page. */
export const ManyPages: Story = {
  args: (() => {
    const entries = Array.from({ length: 28 }, (_, i) =>
      entry(`view-${i}`, `View ${i + 1}`, "LayoutGrid"),
    );
    const ids = entries.map((v) => v.id);
    return {
      entries,
      pageGroups: [ids.slice(0, 14), ids.slice(14)],
    };
  })(),
};

/** Loading skeleton — the placeholder grid shown while the catalog resolves. */
export const Loading: Story = {
  args: { entries: [], pageGroups: [], loading: true },
};

/**
 * Tap-to-launch: clicking a tile fires `onLaunch` with that entry. Driven for
 * real so a regression that swallows the tap fails the story.
 */
export const TileLaunch: Story = {
  args: {
    entries: VIEWS,
    pageGroups: [VIEWS.map((v) => v.id)],
    onLaunch: (e) => {
      launchedId = e.id;
    },
  },
  play: async ({ canvasElement }) => {
    launchedId = null;
    const tile = canvasElement.querySelector(
      '[data-testid="launcher-tile-wallet"] button',
    );
    assert(tile instanceof HTMLButtonElement, "wallet tile button exists");
    tile.click();
    assert(
      launchedId === "wallet",
      `onLaunch fired for wallet (got ${launchedId})`,
    );
  },
};
