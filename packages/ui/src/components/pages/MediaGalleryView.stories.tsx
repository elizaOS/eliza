import type { Meta, StoryObj } from "@storybook/react";
import { withMockApp } from "../../storybook/mock-providers.helpers";
import { MediaGalleryView } from "./MediaGalleryView";

const meta: Meta<typeof MediaGalleryView> = {
  title: "Pages/MediaGalleryView",
  component: MediaGalleryView,
  tags: ["autodocs"],
  decorators: [withMockApp],
};

export default meta;

type Story = StoryObj<typeof MediaGalleryView>;

/**
 * Default mount. With no backend in Storybook the database scan never resolves,
 * so the gallery stays in its "Scanning for media" loading state.
 */
export const Default: Story = {};

/**
 * Same loading state, but with custom navigation injected into the sidebar via
 * the `leftNav` slot.
 */
export const WithLeftNav: Story = {
  args: {
    leftNav: (
      <div className="rounded-sm border border-border/45 bg-bg/35 px-3 py-2 text-xs-tight font-semibold text-muted">
        Memories · Messages · Documents
      </div>
    ),
  },
};

/**
 * Loading state with a content header rendered above the gallery panel.
 */
export const WithContentHeader: Story = {
  args: {
    contentHeader: (
      <div className="flex items-center justify-between px-6 py-3 text-sm font-semibold text-txt">
        <span>Media Gallery</span>
        <button
          type="button"
          className="rounded-sm border border-accent/30 bg-accent/12 px-3 py-1 text-xs-tight text-accent-fg"
          onClick={() => {}}
        >
          Refresh
        </button>
      </div>
    ),
  },
};

/**
 * Both slots populated together.
 */
export const WithNavAndHeader: Story = {
  args: {
    leftNav: (
      <div className="rounded-sm border border-border/45 bg-bg/35 px-3 py-2 text-xs-tight font-semibold text-muted">
        Workspace assets
      </div>
    ),
    contentHeader: (
      <div className="px-6 py-3 text-sm font-semibold text-txt">
        Media Gallery
      </div>
    ),
  },
};
