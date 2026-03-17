import type { Meta, StoryObj } from "@storybook/react";
import React from "react";
import { Stack } from "../components/ui/stack";

const meta: Meta<typeof Stack> = { title: "Atoms/Stack", component: Stack };
export default meta;

export const Default: StoryObj = {
  render: () => (
    <Stack direction="row" spacing="md" align="center">
      {["Agents", "Plugins", "Memory"].map((t) => (
        <div
          key={t}
          className="rounded-lg border border-border bg-bg-accent px-4 py-2 text-xs font-medium"
        >
          {t}
        </div>
      ))}
    </Stack>
  ),
};
