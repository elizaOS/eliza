/**
 * Storybook stories for `AppWindowRenderer`: renders a registered mock overlay
 * app through the slug-resolution + Suspense path, plus the not-found and
 * case-insensitive-slug states.
 */

import type { Meta, StoryObj } from "@storybook/react";
import type { ReactElement } from "react";
import { AppWindowRenderer } from "./AppWindowRenderer";
import type { OverlayAppContext } from "./overlay-app-api";
import { registerOverlayApp } from "./overlay-app-registry";

function MockOverlayComponent(props: OverlayAppContext): ReactElement {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-4 bg-background p-8 text-center">
      <img
        alt="mock app hero"
        className="h-24 w-24 rounded-xl"
        src="https://placehold.co/96x96/orange/white?text=App"
      />
      <h2 className="text-xl font-semibold">Mock Overlay App</h2>
      <p className="max-w-sm text-sm text-muted-foreground">
        This is a registered overlay app rendered through the AppWindowRenderer.
        Theme: {props.uiTheme}.
      </p>
      <button
        type="button"
        className="rounded-md border border-border bg-card px-3 py-1.5 text-sm hover:bg-accent"
        onClick={props.exitToApps}
      >
        {props.t("Exit to apps")}
      </button>
    </div>
  );
}

// Register a mock overlay app exactly once at module scope so the slug
// `mock-window` resolves through the real registry used by the component.
registerOverlayApp({
  name: "@elizaos/plugin-mock-window",
  displayName: "Mock Window",
  description: "Sample overlay app for Storybook.",
  category: "utility",
  icon: null,
  Component: MockOverlayComponent,
});

const meta = {
  title: "Apps/AppWindowRenderer",
  component: AppWindowRenderer,
  tags: ["autodocs"],
  argTypes: {
    slug: { control: "text" },
  },
  args: {
    slug: "mock-window",
  },
  decorators: [
    (Story) => (
      <div className="h-[520px] w-full overflow-hidden rounded-lg border border-border">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof AppWindowRenderer>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const NotFound: Story = {
  args: {
    slug: "this-app-does-not-exist",
  },
};

export const CaseInsensitiveSlug: Story = {
  args: {
    slug: "MOCK-WINDOW",
  },
};
