import type { Meta, StoryObj } from "@storybook/react";
import { withMockApp } from "../../storybook/mock-providers.helpers";
import { DynamicViewLoader } from "./DynamicViewLoader";

/**
 * DynamicViewLoader dynamically imports a remote view bundle and mounts it
 * behind an ErrorBoundary. In Storybook there is no backend serving bundles,
 * so the import never resolves to a component: stories render the loading
 * skeleton first and then the error state once the import rejects. Both are
 * real, useful states of the component.
 */
const meta = {
  title: "Views/DynamicViewLoader",
  component: DynamicViewLoader,
  tags: ["autodocs"],
  decorators: [withMockApp],
  parameters: { layout: "fullscreen" },
  argTypes: {
    bundleUrl: { control: "text" },
    viewId: { control: "text" },
    componentExport: { control: "text" },
    viewType: { control: "inline-radio", options: ["gui", "tui", "xr"] },
    viewProps: { control: false },
  },
  args: {
    bundleUrl: "/api/views/wallet.inventory/bundle.js",
    viewId: "wallet.inventory",
    componentExport: "default",
    viewType: "gui",
  },
  render: (args) => (
    <div className="flex h-[480px] w-full flex-col">
      <DynamicViewLoader {...args} />
    </div>
  ),
} satisfies Meta<typeof DynamicViewLoader>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * Default render: the loader begins importing the bundle and shows the loading
 * skeleton while the (never-resolving) import is in flight.
 */
export const Loading: Story = {};

/** A different view id flowing through the loading state. */
export const LoadingTuiView: Story = {
  args: {
    bundleUrl: "/api/views/terminal.console/bundle.js",
    viewId: "terminal.console",
    viewType: "tui",
  },
};

/**
 * An unresolvable bundle URL makes the dynamic import reject, so the loader
 * settles into its error state showing the failing view id.
 */
export const FailedToLoad: Story = {
  args: {
    bundleUrl: "https://invalid.example.invalid/missing-bundle.js",
    viewId: "broken.view",
  },
};

/** Forwarded view props are merged in before the bundle mounts. */
export const WithForwardedProps: Story = {
  args: {
    bundleUrl: "/api/views/feed.timeline/bundle.js",
    viewId: "feed.timeline",
    viewProps: { title: "Timeline", limit: 25 },
  },
};
