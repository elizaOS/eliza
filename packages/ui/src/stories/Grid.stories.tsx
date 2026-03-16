import type { Meta, StoryObj } from "@storybook/react";
import React from "react";
import { Grid } from "../components/ui/grid";

const meta: Meta<typeof Grid> = { title: "Atoms/Grid", component: Grid };
export default meta;

export const Default: StoryObj = {
  render: () => (
    <Grid columns={3} spacing="sm">
      {["Chat", "Voice", "Vision", "Memory", "Tools", "Deploy"].map((t) => (
        <div
          key={t}
          className="rounded-lg border border-border bg-bg-accent p-4 text-center text-xs font-semibold"
        >
          {t}
        </div>
      ))}
    </Grid>
  ),
};
