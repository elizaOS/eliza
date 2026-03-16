import type { Meta, StoryObj } from "@storybook/react";
import React, { useState } from "react";
import { Button } from "../components/ui/button";
import { ConfirmDialog } from "../components/ui/confirm-dialog";

const meta: Meta<typeof ConfirmDialog> = {
  title: "Molecules/ConfirmDialog",
  component: ConfirmDialog,
};
export default meta;

export const Danger: StoryObj = {
  render: () => {
    const [open, setOpen] = useState(false);
    return (
      <div className="p-4">
        <Button variant="destructive" size="sm" onClick={() => setOpen(true)}>
          Delete Agent
        </Button>
        <ConfirmDialog
          open={open}
          title="Delete Agent"
          message="This will permanently delete the agent and all its data."
          confirmLabel="Delete"
          tone="danger"
          onConfirm={() => setOpen(false)}
          onCancel={() => setOpen(false)}
        />
      </div>
    );
  },
};
