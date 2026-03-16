import { ConfirmModal, PromptModal } from "@milady/app-core/components";
import type { Meta, StoryObj } from "@storybook/react";
import React, { useState } from "react";

const meta: Meta<typeof ConfirmModal> = {
  title: "App Core/ConfirmModal",
  component: ConfirmModal,
};
export default meta;

export const Default: StoryObj = {
  render: () => {
    const [open, setOpen] = useState(true);
    return (
      <>
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="px-4 py-2 border rounded text-sm"
        >
          Open Confirm
        </button>
        <ConfirmModal
          open={open}
          message="Are you sure you want to proceed?"
          onConfirm={() => setOpen(false)}
          onCancel={() => setOpen(false)}
        />
      </>
    );
  },
};

export const DangerTone: StoryObj = {
  render: () => {
    const [open, setOpen] = useState(true);
    return (
      <>
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="px-4 py-2 border rounded text-sm"
        >
          Open Danger
        </button>
        <ConfirmModal
          open={open}
          title="Delete Agent"
          message="This will permanently delete the agent and all associated data. This action cannot be undone."
          confirmLabel="Delete"
          cancelLabel="Keep"
          tone="danger"
          onConfirm={() => setOpen(false)}
          onCancel={() => setOpen(false)}
        />
      </>
    );
  },
};

export const WarnTone: StoryObj = {
  render: () => {
    const [open, setOpen] = useState(true);
    return (
      <>
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="px-4 py-2 border rounded text-sm"
        >
          Open Warning
        </button>
        <ConfirmModal
          open={open}
          title="Reset Settings"
          message="This will reset all settings to their default values."
          confirmLabel="Reset"
          tone="warn"
          onConfirm={() => setOpen(false)}
          onCancel={() => setOpen(false)}
        />
      </>
    );
  },
};

export const Prompt: StoryObj = {
  render: () => {
    const [open, setOpen] = useState(true);
    const [result, setResult] = useState<string | null>(null);
    return (
      <>
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="px-4 py-2 border rounded text-sm"
        >
          Open Prompt
        </button>
        {result && (
          <p className="text-sm text-muted mt-2">
            Entered: &ldquo;{result}&rdquo;
          </p>
        )}
        <PromptModal
          open={open}
          title="Rename Agent"
          message="Enter a new name for your agent."
          placeholder="e.g. Agent Smith"
          defaultValue="Eliza"
          onConfirm={(val) => {
            setResult(val);
            setOpen(false);
          }}
          onCancel={() => setOpen(false)}
        />
      </>
    );
  },
};
