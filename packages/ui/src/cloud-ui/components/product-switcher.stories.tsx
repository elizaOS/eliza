/**
 * Storybook stories for the ProductSwitcher.
 */
import type { Meta, StoryObj } from "@storybook/react";
import { ProductSwitcher } from "./product-switcher";

const meta = {
  title: "CloudUI/ProductSwitcher",
  component: ProductSwitcher,
  tags: ["autodocs"],
  args: {
    "aria-label": "Product switcher",
  },
} satisfies Meta<typeof ProductSwitcher>;

export default meta;
type Story = StoryObj<typeof meta>;

const defaultItems = [
  { label: "Cloud", href: "#cloud", active: true },
  { label: "Agents", href: "#agents" },
  { label: "Docs", href: "#docs" },
  { label: "Pricing", href: "#pricing" },
];

export const Default: Story = {
  args: {
    items: defaultItems,
  },
};

export const AgentsActive: Story = {
  args: {
    items: defaultItems.map((item) => ({
      ...item,
      active: item.label === "Agents",
    })),
  },
};

export const TwoItems: Story = {
  args: {
    items: [
      { label: "Console", href: "#console", active: true },
      { label: "Marketplace", href: "#marketplace" },
    ],
  },
};

export const WithExternalLinks: Story = {
  args: {
    items: [
      { label: "Dashboard", href: "#dashboard", active: true },
      { label: "GitHub", href: "https://github.com", external: true },
      { label: "Discord", href: "https://discord.gg", external: true },
      { label: "Status", href: "https://status.elizaos.ai", external: true },
    ],
  },
};

export const ManyItems: Story = {
  args: {
    items: [
      { label: "Overview", href: "#overview", active: true },
      { label: "Agents", href: "#agents" },
      { label: "Plugins", href: "#plugins" },
      { label: "Knowledge", href: "#knowledge" },
      { label: "Billing", href: "#billing" },
      { label: "Settings", href: "#settings" },
    ],
  },
};
