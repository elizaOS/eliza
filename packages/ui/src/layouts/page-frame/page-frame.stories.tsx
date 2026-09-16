/** Shows the canonical content, workspace, and immersive page-frame policies. */

import type { PageLayoutManifest } from "@elizaos/core";
import type { Meta, StoryObj } from "@storybook/react";

import { Card } from "../../components/ui/card";
import { PageFrame } from "./page-frame";

const meta = {
  title: "Layouts/PageFrame",
  component: PageFrame,
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div className="flex h-screen min-h-0 bg-background text-foreground">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof PageFrame>;

export default meta;
type Story = StoryObj<typeof meta>;

const CONTENT_BLOCKS = [
  "Identity",
  "Activity",
  "Preferences",
  "Connections",
  "Security",
  "Usage",
  "History",
  "Support",
] as const;

function DemonstrationBody({ layout }: { layout: PageLayoutManifest }) {
  return (
    <div className="flex min-h-full flex-col gap-4 py-6">
      <header className="space-y-1">
        <p className="text-sm font-medium text-foreground">
          {layout.kind} page
        </p>
        <p className="text-sm text-muted-foreground">
          Width: {layout.width}. Scroll owner: {layout.scroll}.
        </p>
      </header>
      <div className="grid flex-1 gap-3 sm:grid-cols-2">
        {CONTENT_BLOCKS.map((label) => (
          <Card asChild key={label} variant="flatPadded">
            <section>
              <p className="text-sm font-medium text-card-foreground">
                {label}
              </p>
            </section>
          </Card>
        ))}
      </div>
    </div>
  );
}

export const Content: Story = {
  args: {
    layout: {
      kind: "content",
      width: "reading",
      scroll: "shell",
      gutter: "standard",
    },
    children: null,
  },
  render: ({ layout }) => (
    <PageFrame layout={layout}>
      <DemonstrationBody layout={layout} />
    </PageFrame>
  ),
};

export const Workspace: Story = {
  args: {
    layout: {
      kind: "workspace",
      width: "wide",
      scroll: "view",
      gutter: "standard",
    },
    children: null,
  },
  render: ({ layout }) => (
    <PageFrame layout={layout}>
      <div className="h-full overflow-y-auto">
        <DemonstrationBody layout={layout} />
      </div>
    </PageFrame>
  ),
};

export const Immersive: Story = {
  args: {
    layout: {
      kind: "immersive",
      width: "full",
      scroll: "view",
      gutter: "none",
    },
    children: null,
  },
  render: ({ layout }) => (
    <PageFrame layout={layout}>
      <div className="flex h-full items-center justify-center bg-card">
        <p className="text-sm text-card-foreground">Edge-to-edge view canvas</p>
      </div>
    </PageFrame>
  ),
};
