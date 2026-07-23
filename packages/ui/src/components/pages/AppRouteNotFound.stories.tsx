/**
 * Storybook stories for the `/apps/<slug>` not-found state — the designed
 * failure render for a dead app deep link, in both recovery shapes: launcher
 * only, and a stale-bookmark redirect to a view's canonical path.
 */
import type { Meta, StoryObj } from "@storybook/react";
import { AppRouteNotFound } from "./AppRouteNotFound";

const meta: Meta<typeof AppRouteNotFound> = {
  title: "Pages/AppRouteNotFound",
  component: AppRouteNotFound,
  parameters: { layout: "fullscreen" },
  args: { navigatePath: () => {} },
  decorators: [
    (Story) => (
      <div className="h-[480px] w-full bg-bg">
        <Story />
      </div>
    ),
  ],
};
export default meta;

type Story = StoryObj<typeof AppRouteNotFound>;

export const UnknownSlug: Story = {
  args: { slug: "ghost-app" },
};

export const KnownViewElsewhere: Story = {
  args: {
    slug: "settings",
    matchedView: { label: "Settings", path: "/settings" },
  },
};
