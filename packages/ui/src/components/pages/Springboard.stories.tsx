import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";
import { assert, waitForTestId } from "../../storybook/home-widget-decorator";
import type { ViewEntry } from "../../hooks/view-catalog";
import { Springboard } from "./Springboard";

/** Find a <button> by its exact trimmed text (the toolbar Edit/Done toggle). */
function buttonByText(root: HTMLElement, text: string): HTMLButtonElement | null {
  return (
    [...root.querySelectorAll("button")].find(
      (b) => b.textContent?.trim() === text,
    ) ?? null
  );
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
    assert(launchedId === "wallet", `onLaunch fired for wallet (got ${launchedId})`);
  },
};

/**
 * Edit mode via the toolbar toggle: "Edit" → jiggle mode (per-tile pin badges
 * appear, the toggle reads "Done") → "Done" exits.
 */
export const EditModeToggle: Story = {
  args: { entries: VIEWS },
  play: async ({ canvasElement }) => {
    buttonByText(canvasElement, "Edit")?.click();
    // The per-tile pin affordance appears after the re-render (poll for it).
    await waitForTestId(canvasElement, "springboard-fav-wallet");
    assert(buttonByText(canvasElement, "Done"), "the toggle now reads Done");
    buttonByText(canvasElement, "Done")?.click();
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert(buttonByText(canvasElement, "Edit"), "the toggle returns to Edit");
  },
};

/**
 * Hold-to-edit: a 450ms press on a tile (not a tap) enters edit mode — the iOS
 * gesture. The story-gate keeps real timers, so the press is driven for real
 * (pointerdown → 520ms → pointerup) rather than faked. (The full pointer/touch
 * gesture incl. swipe-paging is covered end-to-end by `test:springboard-e2e`.)
 */
export const LongPressToEdit: Story = {
  args: { entries: VIEWS },
  play: async ({ canvasElement }) => {
    const target = canvasElement.querySelector(
      '[data-testid="springboard-tile-wallet"] button',
    );
    assert(target instanceof HTMLButtonElement, "wallet tile button exists");
    target.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 520));
    target.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
    const done = [...canvasElement.querySelectorAll("button")].some(
      (b) => b.textContent?.trim() === "Done",
    );
    assert(done, "a 520ms long-press entered edit mode (Done shown)");
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
    buttonByText(canvasElement, "Edit")?.click();
    const fav = await waitForTestId(canvasElement, "springboard-fav-memories");
    fav.click();
    const dock = await waitForTestId(canvasElement, "springboard-dock");
    assert(
      dock.querySelector('[aria-label="Memories"]'),
      "the favorited view appears in the dock",
    );
  },
};
