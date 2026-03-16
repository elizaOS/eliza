import type { Meta, StoryObj } from "@storybook/react";
import React from "react";
import { SectionCard } from "../components/ui/section-card";

const meta: Meta<typeof SectionCard> = {
  title: "Molecules/SectionCard",
  component: SectionCard,
};
export default meta;

export const Default: StoryObj = {
  render: () => (
    <SectionCard title="Model Config" collapsible>
      <div className="text-sm text-muted">
        Temperature, max tokens, system prompt.
      </div>
    </SectionCard>
  ),
};
