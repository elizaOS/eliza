import type { Meta, StoryObj } from "@storybook/react";
import { Download, RefreshCcw } from "lucide-react";

import { Button, PagePanel } from "../index";

const meta = {
  title: "Composites/PagePanel",
  component: PagePanel,
  tags: ["autodocs"],
  parameters: {
    layout: "centered",
  },
} satisfies Meta<typeof PagePanel>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Workspace: Story = {
  render: () => (
    <div className="w-[min(100vw-2rem,68rem)]">
      <PagePanel variant="workspace">
        <PagePanel.Header
          eyebrow="Knowledge"
          heading="Vector Browser"
          description="Inspect indexed documents, fragments, and sync status."
          actions={
            <PagePanel.ActionRail className="rounded-full px-1 py-1">
              <Button variant="outline" size="sm" className="rounded-full">
                <RefreshCcw className="mr-1 h-3.5 w-3.5" />
                Refresh
              </Button>
              <Button variant="outline" size="sm" className="rounded-full">
                <Download className="mr-1 h-3.5 w-3.5" />
                Export
              </Button>
            </PagePanel.ActionRail>
          }
        />

        <PagePanel.Frame>
          <PagePanel.ContentArea className="space-y-4 px-4 py-4 sm:px-5 sm:py-5">
            <PagePanel.Toolbar>
              <PagePanel.Meta tone="accent">3 docs</PagePanel.Meta>
              <PagePanel.Meta>12 fragments</PagePanel.Meta>
            </PagePanel.Toolbar>

            <PagePanel.Notice
              tone="accent"
              actions={
                <Button variant="outline" size="sm">
                  Review details
                </Button>
              }
            >
              One source is still reindexing and may return partial results.
            </PagePanel.Notice>

            <div className="grid gap-4 md:grid-cols-2">
              <PagePanel.SummaryCard>
                <div className="text-[11px] uppercase tracking-[0.14em] text-muted/70">
                  Latest upload
                </div>
                <div className="mt-2 text-lg font-semibold text-txt">
                  eliza-cloud-basics.txt
                </div>
                <div className="mt-1 text-sm text-muted">
                  Uploaded Apr 12, 2026
                </div>
              </PagePanel.SummaryCard>

              <PagePanel.SummaryCard>
                <div className="text-[11px] uppercase tracking-[0.14em] text-muted/70">
                  Active filters
                </div>
                <div className="mt-2 text-lg font-semibold text-txt">
                  Plain text + upload sources
                </div>
                <div className="mt-1 text-sm text-muted">
                  Search results are scoped to active knowledge files.
                </div>
              </PagePanel.SummaryCard>
            </div>
          </PagePanel.ContentArea>
        </PagePanel.Frame>
      </PagePanel>
    </div>
  ),
};

export const States: Story = {
  render: () => (
    <div className="grid w-[min(100vw-2rem,68rem)] gap-4 lg:grid-cols-2">
      <PagePanel.Empty
        variant="surface"
        title="No fragments indexed"
        description="Upload a document or connect a synced source to get started."
      />
      <PagePanel.Loading
        variant="surface"
        heading="Rebuilding vectors"
        description="Documents are being chunked and embedded."
      />
    </div>
  ),
};
