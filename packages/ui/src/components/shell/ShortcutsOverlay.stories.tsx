/**
 * Storybook states for the ShortcutsOverlay shell surface across startup,
 * launcher, banner, and overlay contexts.
 */
import type { Meta, StoryObj } from "@storybook/react";
import { mockApp } from "../../storybook/mock-providers.helpers";
import { ShortcutsOverlay } from "./ShortcutsOverlay";

// Unlike the context-gated shell banners, this overlay's visibility is local
// state: it stays hidden until its own `window` keydown listener sees `Shift+?`,
// which flips an internal `open` flag. It reads only `t` from useApp(), so the
// default mock context is enough — we just have to summon the dialog. Dispatch
// the keydown after render so the cheat sheet is actually visible in the story.
function openOverlay() {
  window.dispatchEvent(
    new KeyboardEvent("keydown", { key: "?", shiftKey: true }),
  );
}

const meta = {
  title: "Shell/ShortcutsOverlay",
  component: ShortcutsOverlay,
  tags: ["autodocs"],
  decorators: [mockApp()],
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof ShortcutsOverlay>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Resting — nothing visible until the user presses Shift+? to summon it. */
export const Closed: Story = {};

/** The cheat sheet open: shortcuts grouped by scope with formatted key caps. */
export const Open: Story = {
  play: () => {
    openOverlay();
  },
};
