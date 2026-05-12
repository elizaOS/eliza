import type { Meta, StoryObj } from "@storybook/react";

/**
 * ChatAvatar depends on @elizaos/app-core/state (useApp) and VrmViewer
 * (WebGL). Full rendering requires a 3D context.
 *
 * This placeholder story documents the component interface; interactive
 * stories will be added once a MockVrmScene decorator is available.
 */

function ChatAvatarPlaceholder() {
  return (
    <div className="flex flex-col items-center gap-4 p-8">
      <div className="h-48 w-48 rounded-full bg-muted flex items-center justify-center text-muted-foreground">
        <span className="text-4xl">VRM</span>
      </div>
      <p className="text-sm text-muted-foreground">
        ChatAvatar renders a live VRM avatar in the chat sidebar.
        <br />
        Requires WebGL context — see CompanionSceneHost for full 3D stories.
      </p>
    </div>
  );
}

const meta = {
  title: "Companion/ChatAvatar",
  component: ChatAvatarPlaceholder,
  tags: ["autodocs"],
  parameters: {
    layout: "centered",
  },
} satisfies Meta<typeof ChatAvatarPlaceholder>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Placeholder: Story = {};
