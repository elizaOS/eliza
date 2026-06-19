import type { Meta, StoryObj } from "@storybook/react";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "./resizable";

const PanelContent = ({
  label,
  tone = "default",
}: {
  label: string;
  tone?: "default" | "accent" | "muted";
}) => {
  const bg =
    tone === "accent"
      ? "bg-orange-500/10"
      : tone === "muted"
        ? "bg-white/[0.02]"
        : "bg-white/5";
  return (
    <div
      className={`flex h-full w-full items-center justify-center ${bg} p-4 text-sm text-white/80`}
    >
      <div className="text-center">
        <div className="font-medium">{label}</div>
        <div className="mt-1 text-xs text-white/40">
          Drag the gutter to resize
        </div>
      </div>
    </div>
  );
};

const meta = {
  title: "CloudUI/Resizable",
  component: ResizablePanelGroup,
  tags: ["autodocs"],
  parameters: {
    layout: "fullscreen",
  },
  decorators: [
    (Story) => (
      <div className="h-[420px] w-full bg-black p-4">
        <div className="h-full w-full overflow-hidden rounded-lg border border-white/10">
          <Story />
        </div>
      </div>
    ),
  ],
} satisfies Meta<typeof ResizablePanelGroup>;

export default meta;
type Story = StoryObj<typeof meta>;

export const HorizontalSplit: Story = {
  args: {
    direction: "horizontal",
  },
  render: (args) => (
    <ResizablePanelGroup {...args}>
      <ResizablePanel defaultSize={35}>
        <PanelContent label="Sidebar" tone="muted" />
      </ResizablePanel>
      <ResizableHandle />
      <ResizablePanel defaultSize={65}>
        <PanelContent label="Main content" />
      </ResizablePanel>
    </ResizablePanelGroup>
  ),
};

export const VerticalSplit: Story = {
  args: {
    direction: "vertical",
  },
  render: (args) => (
    <ResizablePanelGroup {...args}>
      <ResizablePanel defaultSize={60}>
        <PanelContent label="Editor" />
      </ResizablePanel>
      <ResizableHandle />
      <ResizablePanel defaultSize={40}>
        <PanelContent label="Console" tone="muted" />
      </ResizablePanel>
    </ResizablePanelGroup>
  ),
};

export const WithVisibleHandle: Story = {
  args: {
    direction: "horizontal",
  },
  render: (args) => (
    <ResizablePanelGroup {...args}>
      <ResizablePanel defaultSize={50}>
        <PanelContent label="Left pane" />
      </ResizablePanel>
      <ResizableHandle withHandle />
      <ResizablePanel defaultSize={50}>
        <PanelContent label="Right pane" tone="accent" />
      </ResizablePanel>
    </ResizablePanelGroup>
  ),
};

export const ConstrainedSizes: Story = {
  args: {
    direction: "horizontal",
  },
  render: (args) => (
    <ResizablePanelGroup {...args}>
      <ResizablePanel defaultSize={30} minSize={20} maxSize={45}>
        <PanelContent label="Min 20% / Max 45%" tone="muted" />
      </ResizablePanel>
      <ResizableHandle withHandle />
      <ResizablePanel defaultSize={70} minSize={55} maxSize={80}>
        <PanelContent label="Min 55% / Max 80%" />
      </ResizablePanel>
    </ResizablePanelGroup>
  ),
};
