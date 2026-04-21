import type { Meta, StoryObj } from "@storybook/react";
import { Bot, Globe, HeartPulse, Wallet } from "lucide-react";
import type React from "react";
import { useState } from "react";

import {
  Button,
  Sidebar,
  SidebarContent,
  SidebarHeader,
  SidebarPanel,
  SidebarScrollRegion,
} from "../index";

const navItems = [
  {
    key: "character",
    label: "Character",
    description: "Persona, examples, and knowledge",
    icon: Bot,
    active: true,
  },
  {
    key: "wallet",
    label: "Wallet",
    description: "Balances, approvals, and activity",
    icon: Wallet,
  },
  {
    key: "browser",
    label: "Browser",
    description: "Tabs, navigation, and relay controls",
    icon: Globe,
  },
  {
    key: "heartbeats",
    label: "Heartbeats",
    description: "Recurring prompts and automations",
    icon: HeartPulse,
  },
] as const;

function SidebarCanvas({
  collapsed = false,
  variant = "default",
}: {
  collapsed?: boolean;
  variant?: React.ComponentProps<typeof Sidebar>["variant"];
}) {
  const [searchValue, setSearchValue] = useState("");

  return (
    <div className="h-[760px] w-[min(100vw-2rem,23rem)] p-3">
      <Sidebar
        variant={variant}
        collapsible={variant === "default"}
        collapsed={variant === "default" ? collapsed : undefined}
        header={
          <SidebarHeader
            search={{
              value: searchValue,
              onChange: (event) => setSearchValue(event.target.value),
              onClear: () => setSearchValue(""),
              placeholder: "Search workspaces...",
              "aria-label": "Search workspaces",
            }}
          >
            <SidebarContent.Toolbar>
              <SidebarContent.ToolbarPrimary>
                <SidebarContent.SectionHeader meta="4">
                  <SidebarContent.SectionLabel>
                    Workspace
                  </SidebarContent.SectionLabel>
                </SidebarContent.SectionHeader>
              </SidebarContent.ToolbarPrimary>
              <SidebarContent.ToolbarActions>
                <Button variant="outline" size="sm">
                  New
                </Button>
              </SidebarContent.ToolbarActions>
            </SidebarContent.Toolbar>
          </SidebarHeader>
        }
        footer={
          <SidebarContent.Notice>
            2 wallet approvals are waiting for review.
          </SidebarContent.Notice>
        }
        mobileTitle={
          <SidebarContent.SectionLabel>Workspace</SidebarContent.SectionLabel>
        }
        mobileMeta={String(navItems.length)}
        onMobileClose={variant === "mobile" ? () => undefined : undefined}
        collapsedRailAction={
          <Button
            type="button"
            variant="surfaceAccent"
            size="icon"
            className="h-11 w-11 rounded-[14px]"
            aria-label="Create workspace"
          >
            +
          </Button>
        }
        collapsedRailItems={navItems.map((item) => (
          <SidebarContent.RailItem
            key={item.key}
            active={item.active}
            aria-label={item.label}
            title={item.label}
            indicatorTone={item.active ? "accent" : undefined}
          >
            <item.icon className="h-4 w-4" />
          </SidebarContent.RailItem>
        ))}
      >
        <SidebarScrollRegion variant={variant}>
          <SidebarPanel variant={variant}>
            <SidebarContent.SectionHeader meta="Primary">
              <SidebarContent.SectionLabel>Pages</SidebarContent.SectionLabel>
            </SidebarContent.SectionHeader>

            <div className="space-y-2">
              {navItems.map((item) => (
                <SidebarContent.Item
                  key={item.key}
                  as="div"
                  active={item.active}
                >
                  <SidebarContent.ItemButton>
                    <SidebarContent.ItemIcon active={item.active}>
                      <item.icon className="h-4 w-4" />
                    </SidebarContent.ItemIcon>
                    <SidebarContent.ItemBody>
                      <SidebarContent.ItemTitle>
                        {item.label}
                      </SidebarContent.ItemTitle>
                      <SidebarContent.ItemDescription>
                        {item.description}
                      </SidebarContent.ItemDescription>
                    </SidebarContent.ItemBody>
                  </SidebarContent.ItemButton>
                </SidebarContent.Item>
              ))}
            </div>
          </SidebarPanel>
        </SidebarScrollRegion>
      </Sidebar>
    </div>
  );
}

const meta = {
  title: "Composites/Sidebar",
  component: Sidebar,
  tags: ["autodocs"],
  parameters: {
    layout: "centered",
  },
} satisfies Meta<typeof Sidebar>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Expanded: Story = {
  render: () => <SidebarCanvas />,
};

export const Collapsed: Story = {
  render: () => <SidebarCanvas collapsed />,
};

export const Mobile: Story = {
  render: () => <SidebarCanvas variant="mobile" />,
  parameters: {
    viewport: { defaultViewport: "mobilePortrait" },
  },
};
