/** Storybook coverage for the shared empty/loading content-state molecule. */
import type { Meta, StoryObj } from "@storybook/react";
import { AlertTriangle } from "lucide-react";
import { Button } from "../../ui/button";
import { ContentState } from "./content-state";

const meta = {
  title: "Composites/PagePanel/ContentState",
  component: ContentState,
  tags: ["autodocs"],
} satisfies Meta<typeof ContentState>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Empty: Story = {
  args: {
    state: "empty",
    title: "No agents yet",
    description: "Create your first agent to start a conversation.",
    action: <Button>Create agent</Button>,
  },
};

export const Loading: Story = {
  args: {
    state: "loading",
    heading: "Loading workspace",
    description: "Fetching your agents and recent activity.",
  },
};

export const WorkspaceEmpty: Story = {
  args: {
    state: "empty",
    placement: "workspace",
    title: "Nothing here yet",
    description: "Content will appear here when it is available.",
  },
};

export const SurfaceLoading: Story = {
  args: {
    state: "loading",
    placement: "surface",
    heading: "Preparing your surface",
    description: "This usually takes a few seconds.",
  },
};

export const RecoverableError: Story = {
  args: {
    state: "error",
    placement: "surface",
    icon: <AlertTriangle className="size-5" />,
    title: "Calendar unavailable",
    description: "Reconnect to refresh your events.",
    action: <Button variant="outline">Retry</Button>,
  },
};
