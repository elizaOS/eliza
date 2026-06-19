import type { Meta, StoryObj } from "@storybook/react";
import { mockApp } from "../../storybook/mock-providers.helpers";
import { AppDetailsView } from "./AppDetailsView";

/**
 * `AppDetailsView` is the config + diagnostics + launch page for an app,
 * mounted at `/apps/<slug>/details`. It resolves the slug against the
 * in-memory internal-tool / overlay registries and the (network-backed)
 * registry catalog. In Storybook the catalog never loads, so catalog-only
 * slugs fall through to the "not found" state, while internal-tool slugs
 * such as `lifeops` resolve from the in-memory registry and render fully.
 */
const meta = {
  title: "Pages/AppDetailsView",
  component: AppDetailsView,
  tags: ["autodocs"],
  parameters: { layout: "fullscreen" },
  decorators: [mockApp()],
  args: {
    slug: "lifeops",
    onLaunched: () => {},
  },
} satisfies Meta<typeof AppDetailsView>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Internal-tool app resolved from the in-memory registry (LifeOps). */
export const Default: Story = {};

/** Same app, but with live runs surfaced in the header + Recent Runs. */
export const WithActiveRuns: Story = {
  decorators: [
    mockApp({
      appRuns: [
        {
          runId: "run-7c1f",
          appName: "@elizaos/plugin-personal-assistant",
          displayName: "LifeOps",
          status: "running",
        },
        {
          runId: "run-3a90",
          appName: "@elizaos/plugin-personal-assistant",
          displayName: "LifeOps",
          status: "exited",
        },
        // Unrelated run — filtered out by appName.
        {
          runId: "run-zzzz",
          appName: "@elizaos/app-other",
          displayName: "Other",
          status: "running",
        },
      ] as never,
    }),
  ],
};

/** Plugin Viewer — another internal-tool app, dedicated-window only. */
export const PluginViewer: Story = {
  args: { slug: "plugins" },
};

/** Catalog-only slug: the network catalog never loads, so it resolves to the not-found empty state. */
export const NotFound: Story = {
  args: { slug: "some-unknown-third-party-app" },
};
