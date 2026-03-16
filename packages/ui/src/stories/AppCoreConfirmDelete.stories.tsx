import { ConfirmDeleteControl } from "@milady/app-core/components";
import type { Meta, StoryObj } from "@storybook/react";
import React from "react";

const meta: Meta<typeof ConfirmDeleteControl> = {
  title: "App Core/ConfirmDeleteControl",
  component: ConfirmDeleteControl,
};
export default meta;

export const Default: StoryObj = {
  render: () => (
    <div className="flex items-center gap-2">
      <ConfirmDeleteControl
        onConfirm={() => alert("Deleted!")}
        triggerClassName="px-3 py-1.5 text-xs bg-transparent text-[#e74c3c] border border-[#e74c3c] rounded cursor-pointer hover:bg-[#e74c3c] hover:text-white transition-colors"
        confirmClassName="px-3 py-1.5 text-xs bg-[#e74c3c] text-white border border-[#e74c3c] rounded cursor-pointer hover:opacity-90 transition-opacity"
        cancelClassName="px-3 py-1.5 text-xs bg-transparent text-[var(--muted)] border border-[var(--border)] rounded cursor-pointer hover:text-white transition-colors"
      />
    </div>
  ),
};

export const CustomLabels: StoryObj = {
  render: () => (
    <div className="flex items-center gap-2">
      <ConfirmDeleteControl
        onConfirm={() => alert("Removed!")}
        triggerLabel="Remove Agent"
        confirmLabel="Yes, Remove"
        cancelLabel="Keep"
        promptText="Remove this agent?"
        triggerClassName="px-3 py-1.5 text-xs bg-transparent text-[#e74c3c] border border-[#e74c3c] rounded cursor-pointer hover:bg-[#e74c3c] hover:text-white transition-colors"
        confirmClassName="px-3 py-1.5 text-xs bg-[#e74c3c] text-white border border-[#e74c3c] rounded cursor-pointer hover:opacity-90 transition-opacity"
        cancelClassName="px-3 py-1.5 text-xs bg-transparent text-[var(--muted)] border border-[var(--border)] rounded cursor-pointer hover:text-white transition-colors"
      />
    </div>
  ),
};

export const Disabled: StoryObj = {
  render: () => (
    <div className="flex items-center gap-2">
      <ConfirmDeleteControl
        onConfirm={() => {}}
        disabled
        triggerClassName="px-3 py-1.5 text-xs bg-transparent text-[#e74c3c] border border-[#e74c3c] rounded cursor-pointer disabled:opacity-40 disabled:cursor-default"
        confirmClassName="px-3 py-1.5 text-xs bg-[#e74c3c] text-white rounded cursor-pointer"
        cancelClassName="px-3 py-1.5 text-xs bg-transparent text-[var(--muted)] border border-[var(--border)] rounded cursor-pointer"
      />
    </div>
  ),
};
