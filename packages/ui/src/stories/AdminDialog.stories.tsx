import type { Meta, StoryObj } from "@storybook/react";

import {
  AdminDialog,
  Button,
  Dialog,
  DialogDescription,
  DialogTitle,
} from "../index";

const meta = {
  title: "UI/AdminDialog",
  component: AdminDialog.Content,
  tags: ["autodocs"],
  parameters: {
    layout: "fullscreen",
  },
} satisfies Meta<typeof AdminDialog.Content>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => (
    <div className="min-h-screen bg-bg/60 p-6">
      <Dialog open>
        <AdminDialog.Content showCloseButton={false} className="max-w-[42rem]">
          <AdminDialog.Header>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="space-y-1">
                <DialogTitle>Runtime Policy</DialogTitle>
                <DialogDescription>
                  Inspect and edit the managed policy payload before publishing.
                </DialogDescription>
              </div>
              <div className="flex items-center gap-2">
                <AdminDialog.MetaBadge>staging</AdminDialog.MetaBadge>
                <AdminDialog.MonoMeta>policy.json</AdminDialog.MonoMeta>
              </div>
            </div>
          </AdminDialog.Header>

          <AdminDialog.SegmentedTabList>
            <AdminDialog.SegmentedTab active>JSON</AdminDialog.SegmentedTab>
            <AdminDialog.SegmentedTab>Preview</AdminDialog.SegmentedTab>
          </AdminDialog.SegmentedTabList>

          <AdminDialog.BodyScroll className="max-h-[28rem]">
            <div className="space-y-5 p-5">
              <div className="grid gap-2">
                <label
                  htmlFor="policy-name-demo"
                  className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted/75"
                >
                  Policy Name
                </label>
                <AdminDialog.Input
                  id="policy-name-demo"
                  readOnly
                  value="wallet-approval-policy"
                  aria-label="Policy name"
                />
              </div>

              <div className="overflow-hidden rounded-[20px] border border-border/40">
                <AdminDialog.CodeEditor
                  readOnly
                  aria-label="Runtime policy JSON"
                  value={`{
  "mode": "approval_required",
  "scopes": ["wallet.send", "browser.open_external"],
  "rateLimitPerHour": 12,
  "environments": ["desktop", "mobile"]
}`}
                />
              </div>
            </div>
          </AdminDialog.BodyScroll>

          <AdminDialog.Footer>
            <Button variant="outline">Cancel</Button>
            <Button>Publish</Button>
          </AdminDialog.Footer>
        </AdminDialog.Content>
      </Dialog>
    </div>
  ),
};

export const ReviewMode: Story = {
  render: () => (
    <div className="min-h-screen bg-bg/60 p-6">
      <Dialog open>
        <AdminDialog.Content showCloseButton={false} className="max-w-[38rem]">
          <AdminDialog.Header>
            <div className="space-y-2">
              <DialogTitle>Cloud Redirect Review</DialogTitle>
              <DialogDescription>
                Confirm the hostname and callback route before saving.
              </DialogDescription>
            </div>
          </AdminDialog.Header>

          <AdminDialog.BodyScroll className="max-h-[22rem]">
            <div className="space-y-4 p-5">
              <div className="grid gap-2">
                <label
                  htmlFor="origin-demo"
                  className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted/75"
                >
                  Origin
                </label>
                <AdminDialog.Input
                  id="origin-demo"
                  readOnly
                  value="https://eliza.cloud/apps/demo"
                  aria-label="App origin"
                />
              </div>
              <div className="rounded-[18px] border border-border/35 bg-bg/45 px-4 py-3">
                <div className="text-sm font-medium text-txt">
                  Callback route
                </div>
                <div className="mt-1 text-[13px] text-muted">
                  /auth/callback
                </div>
              </div>
            </div>
          </AdminDialog.BodyScroll>

          <AdminDialog.Footer>
            <Button variant="outline">Close</Button>
            <Button>Approve</Button>
          </AdminDialog.Footer>
        </AdminDialog.Content>
      </Dialog>
    </div>
  ),
};
