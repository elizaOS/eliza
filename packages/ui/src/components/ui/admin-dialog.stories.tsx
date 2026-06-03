import type { Meta, StoryObj } from "@storybook/react";
import {
  AdminDialogBodyScroll,
  AdminDialogContent,
  AdminDialogFooterChrome,
  AdminDialogHeader,
  AdminInput,
  AdminMetaBadge,
  AdminMonoMeta,
} from "./admin-dialog";
import { Button } from "./button";
import { Dialog, DialogTitle } from "./dialog";

// AdminDialogContent wraps the Radix DialogContent, so it renders inside an open
// Dialog (content portals to the body). The pieces compose the admin chrome.
const meta = {
  title: "Primitives/AdminDialog",
  component: AdminDialogContent,
  parameters: { layout: "centered" },
} satisfies Meta<typeof AdminDialogContent>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => (
    <Dialog open>
      <AdminDialogContent className="max-w-lg">
        <AdminDialogHeader>
          <DialogTitle className="text-sm font-semibold text-txt">
            Edit agent
          </DialogTitle>
          <AdminMonoMeta>id: agent_01h9x…</AdminMonoMeta>
        </AdminDialogHeader>
        <AdminDialogBodyScroll className="px-5 py-4">
          <div className="flex flex-col gap-3">
            <AdminMetaBadge>builtin</AdminMetaBadge>
            <AdminInput placeholder="Display name" defaultValue="Chen" />
            <AdminInput placeholder="Model" defaultValue="claude-opus-4-8" />
          </div>
        </AdminDialogBodyScroll>
        <AdminDialogFooterChrome>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm">
              Cancel
            </Button>
            <Button size="sm">Save</Button>
          </div>
        </AdminDialogFooterChrome>
      </AdminDialogContent>
    </Dialog>
  ),
};
