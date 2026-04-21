import type { Meta, StoryObj } from "@storybook/react";
import { Cpu, ShieldCheck, Sparkles } from "lucide-react";

import { SkillSidebarItem } from "../index";

const meta = {
  title: "Composites/Skills",
  component: SkillSidebarItem,
  tags: ["autodocs"],
  parameters: {
    layout: "centered",
  },
} satisfies Meta<typeof SkillSidebarItem>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => (
    <div className="w-[min(100vw-2rem,24rem)] space-y-3 rounded-[28px] border border-border/35 bg-[linear-gradient(180deg,color-mix(in_srgb,var(--card)_82%,transparent),color-mix(in_srgb,var(--bg)_96%,transparent))] p-3 shadow-[0_24px_40px_-32px_rgba(15,23,42,0.18)]">
      <SkillSidebarItem
        active
        enabled
        name="Runtime audit"
        description="Checks process health, routes, and local state before changes are applied."
        onLabel="Enabled"
        offLabel="Disabled"
        attentionLabel="Priority"
        icon={<ShieldCheck className="h-4 w-4" />}
      />
      <SkillSidebarItem
        enabled={false}
        name="Cloud deploy"
        description="Publishes the linked app and syncs monetization settings."
        onLabel="Enabled"
        offLabel="Disabled"
        icon={<Sparkles className="h-4 w-4" />}
      />
      <SkillSidebarItem
        enabled
        name="Local tools"
        description="Provides terminal, filesystem, and code edit helpers."
        onLabel="Enabled"
        offLabel="Disabled"
        icon={<Cpu className="h-4 w-4" />}
      />
    </div>
  ),
};
