import type { Meta, StoryObj } from "@storybook/react";
import { withMockApp } from "../../storybook/mock-providers";
import { LoadingScreen } from "./LoadingScreen";

const MOCK_VRM_URL = "data:model/gltf-binary;base64,Z2xURgAAAAAAAAAAAAAAAA==";

/**
 * LoadingScreen is prop-gated, not context-gated: it always renders the
 * NieR-style loader and reads only `t` from useApp() (supplied by the mock).
 * The visible progress bar / phase label are driven by the `phase` prop (and
 * optionally `vrmUrl`), so visibility is controlled entirely through args.
 */
const meta = {
  title: "Shell/LoadingScreen",
  component: LoadingScreen,
  tags: ["autodocs"],
  decorators: [withMockApp],
  argTypes: {
    phase: {
      control: "select",
      options: ["starting-backend", "initializing-agent", "ready"],
    },
    vrmUrl: { control: "text" },
  },
  args: {
    phase: "starting-backend",
  },
} satisfies Meta<typeof LoadingScreen>;

export default meta;
type Story = StoryObj<typeof meta>;

export const StartingBackend: Story = {
  args: { phase: "starting-backend" },
};

export const InitializingAgent: Story = {
  args: { phase: "initializing-agent" },
};

export const Ready: Story = {
  args: { phase: "ready" },
};

export const WithAvatarPrefetch: Story = {
  args: {
    phase: "initializing-agent",
    vrmUrl: MOCK_VRM_URL,
  },
};
