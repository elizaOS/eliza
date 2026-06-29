import type { Meta, StoryObj } from "@storybook/react";
import type { ViewEntry } from "../../hooks/view-catalog";
import { assert, waitForTestId } from "../../storybook/home-widget-decorator";
import { Launcher } from "./Launcher";

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
  const rect = target.getBoundingClientRect();
  const clientX = rect.left + rect.width / 2;
  const clientY = rect.top + rect.height / 2;
  target.dispatchEvent(
    new PointerEvent("pointerdown", {
      bubbles: true,
      cancelable: true,
      composed: true,
      pointerId: 1,
      pointerType: "mouse",
      isPrimary: true,
      button: 0,
      buttons: 1,
      clientX,
      clientY,
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 520));
  target.dispatchEvent(
    new PointerEvent("pointerup", {
      bubbles: true,
      cancelable: true,
      composed: true,
      pointerId: 1,
      pointerType: "mouse",
      isPrimary: true,
      button: 0,
      buttons: 0,
      clientX,
      clientY,
    }),
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

/** A tile button is pulsing exactly while edit mode is active. */
function tilePulsing(root: HTMLElement, testId: string): boolean {
  const button = root.querySelector(`[data-testid="${testId}"] button`);
  return Boolean(button?.classList.contains("animate-pulse"));
}

async function waitForMissingTestId(
  root: HTMLElement,
  testId: string,
  tries = 30,
): Promise<void> {
  for (let i = 0; i < tries; i += 1) {
    if (!root.querySelector(`[data-testid="${testId}"]`)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    `[story] timed out waiting for [data-testid="${testId}"] to disappear`,
  );
}

/**
 * Edit mode is a long-press toggle (there is no Edit button): one long-press on
 * a tile enters jiggle mode (tiles pulse); a second long-press exits it.
 */
export const EditModeToggle: Story = {
  args: { entries: VIEWS },
  play: async ({ canvasElement }) => {
    await longPressTile(canvasElement, "launcher-tile-wallet");
    await waitForTestId(canvasElement, "launcher-fav-wallet");
    assert(
      tilePulsing(canvasElement, "launcher-tile-wallet"),
      "first long-press enters edit mode (tile pulses)",
    );
    await longPressTile(canvasElement, "launcher-tile-wallet");
    await waitForMissingTestId(canvasElement, "launcher-fav-wallet");
    assert(
      !tilePulsing(canvasElement, "launcher-tile-wallet"),
      "a second long-press exits edit mode (pulse gone)",
    );
  },
};

/**
 * Hold-to-edit: a 450ms press on a tile (not a tap) enters edit mode — the iOS
 * gesture and the sole entry point now that the Edit button is gone. The
 * story-gate keeps real timers, so the press is driven for real (pointerdown →
 * 520ms → pointerup) rather than faked. (The full pointer/touch gesture incl.
 * swipe-paging is covered end-to-end by `test:launcher-e2e`.)
 */
export const LongPressToEdit: Story = {
  args: { entries: VIEWS },
  play: async ({ canvasElement }) => {
    await longPressTile(canvasElement, "launcher-tile-wallet");
    await waitForTestId(canvasElement, "launcher-fav-wallet");
    assert(
      tilePulsing(canvasElement, "launcher-tile-wallet"),
      "a 520ms long-press entered edit mode (tile pulses)",
    );
  },
};
