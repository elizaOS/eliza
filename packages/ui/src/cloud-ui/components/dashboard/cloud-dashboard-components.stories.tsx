/**
 * Storybook stories for the composed cloud dashboard components (empty states, cards).
 */
import type { Meta, StoryObj } from "@storybook/react";
import { BrandButton } from "../brand/brand-button";
import {
  AppsEmptyState,
  AppsSkeleton,
  ContainersEmptyState,
  ContainersSkeleton,
  DashboardActionCards,
  DashboardActionCardsSkeleton,
} from "./cloud-dashboard-components";

const meta = {
  title: "CloudUI/Dashboard/CloudDashboardComponents",
  component: DashboardActionCards,
  tags: ["autodocs"],
  parameters: {
    layout: "padded",
    backgrounds: { default: "dark" },
  },
  decorators: [
    (Story) => (
      <div className="min-h-[400px] bg-black p-6 text-white">
        <Story />
      </div>
    ),
  ],
  argTypes: {
    creditBalance: { control: "number" },
  },
  args: {
    creditBalance: 42.5,
  },
} satisfies Meta<typeof DashboardActionCards>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ActionCardsWithBalance: Story = {
  args: {
    creditBalance: 128.43,
  },
};

export const ActionCardsLowBalance: Story = {
  args: {
    creditBalance: 0.0123,
  },
};

export const ActionCardsZeroBalance: Story = {
  args: {
    creditBalance: 0,
  },
};

export const ActionCardsBalanceUnavailable: Story = {
  args: {
    creditBalance: null,
  },
};

export const ActionCardsLoading: Story = {
  render: () => <DashboardActionCardsSkeleton />,
};

export const AppsEmptyDefault: Story = {
  render: () => (
    <div className="mx-auto max-w-2xl">
      <AppsEmptyState />
    </div>
  ),
};

export const AppsEmptyWithAction: Story = {
  render: () => (
    <div className="mx-auto max-w-2xl">
      <AppsEmptyState
        description="Publish your first app to start earning."
        action={<BrandButton onClick={() => undefined}>Create app</BrandButton>}
      />
    </div>
  ),
};

export const AppsListLoading: Story = {
  render: () => (
    <div className="mx-auto max-w-2xl">
      <AppsSkeleton />
    </div>
  ),
};

export const ContainersLoading: Story = {
  render: () => <ContainersSkeleton />,
};

export const ContainersEmpty: Story = {
  render: () => <ContainersEmptyState />,
};
