import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";
import type { ViewEntry } from "../../hooks/view-catalog";
import { assert, waitForTestId } from "../../storybook/home-widget-decorator";
import { Springboard } from "./Springboard";

/**
 * Drive a real long-press on a tile — the only way into edit mode now that the
 * Edit button is gone. The story-gate keeps real timers, so this presses for
 * real (pointerdown → 520ms hold → pointerup).
 */
async function longPressTile(root: HTMLElement, testId: string): Promise<void> {
  const target = root.querySelector(`[data-testid="${testId}"] button`);
  if (!(target instanceof HTMLButtonElement)) {
    throw new Error(`${testId} tile button not found`);
  }
  target.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 520));
  target.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
}

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

const meta: Meta<typeof Springboard> = {
  title: "Pages/Springboard",
  component: Springboard,
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

type Story = StoryObj<typeof Springboard>;

export const Default: Story = {
  args: { entries: VIEWS },
};

export const ManyPages: Story = {
  args: {
    entries: Array.from({ length: 28 }, (_, i) =>
      entry(`view-${i}`, `View ${i + 1}`, "LayoutGrid"),
    ),
  },
};

/** Loading skeleton — the placeholder grid shown while the catalog resolves. */
export const Loading: Story = {
  args: { entries: [], loading: true },
};

/**
 * Tap-to-launch: outside edit mode, clicking a tile fires `onLaunch` with that
 * entry. Driven for real so a regression that swallows the tap fails the story.
 */
export const TileLaunch: Story = {
  args: {
    entries: VIEWS,
    onLaunch: (e) => {
      launchedId = e.id;
    },
  },
  play: async ({ canvasElement }) => {
    launchedId = null;
    const tile = canvasElement.querySelector(
      '[data-testid="springboard-tile-wallet"] button',
    );
    assert(tile instanceof HTMLButtonElement, "wallet tile button exists");
    tile.click();
    assert(
      launchedId === "wallet",
      `onLaunch fired for wallet (got ${launchedId})`,
    );
  },
};

/**
 * Edit mode is a long-press toggle (there is no Edit button): one long-press on
 * a tile enters jiggle mode (per-tile pin badges appear); a second long-press
 * exits it.
 */
export const EditModeToggle: Story = {
  args: { entries: VIEWS },
  play: async ({ canvasElement }) => {
    await longPressTile(canvasElement, "springboard-tile-wallet");
    // The per-tile pin affordance appears after the re-render (poll for it).
    await waitForTestId(canvasElement, "springboard-fav-wallet");
    await longPressTile(canvasElement, "springboard-tile-wallet");
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert(
      !canvasElement.querySelector('[data-testid="springboard-fav-wallet"]'),
      "a second long-press exits edit mode (pin badges gone)",
    );
  },
};

/**
 * Hold-to-edit: a 450ms press on a tile (not a tap) enters edit mode — the iOS
 * gesture and the sole entry point now that the Edit button is gone. The
 * story-gate keeps real timers, so the press is driven for real (pointerdown →
 * 520ms → pointerup) rather than faked. (The full pointer/touch gesture incl.
 * swipe-paging is covered end-to-end by `test:springboard-e2e`.)
 */
export const LongPressToEdit: Story = {
  args: { entries: VIEWS },
  play: async ({ canvasElement }) => {
    await longPressTile(canvasElement, "springboard-tile-wallet");
    // Edit mode shows per-tile pin badges; assert one is present.
    await waitForTestId(canvasElement, "springboard-fav-wallet");
    assert(
      canvasElement.querySelector('[data-testid="springboard-fav-wallet"]'),
      "a 520ms long-press entered edit mode (pin badge shown)",
    );
  },
};

/**
 * Favoriting: in edit mode the per-tile pin toggles the view into the favorites
 * dock. Controlled by local state here (deterministic, no persisted layout), so
 * the dock filling proves the toggle wired the favorite end-to-end.
 */
export const FavoriteIntoDock: Story = {
  args: { entries: VIEWS },
  render: (args) => {
    const [favorites, setFavorites] = useState<string[]>([]);
    return (
      <Springboard
        {...args}
        favoriteIds={favorites}
        onToggleFavorite={(id) =>
          setFavorites((prev) =>
            prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
          )
        }
      />
    );
  },
  play: async ({ canvasElement }) => {
    await longPressTile(canvasElement, "springboard-tile-memories");
    const fav = await waitForTestId(canvasElement, "springboard-fav-memories");
    fav.click();
    const dock = await waitForTestId(canvasElement, "springboard-dock");
    assert(
      dock.querySelector('[aria-label="Memories"]'),
      "the favorited view appears in the dock",
    );
  },
};
