import type { Meta, StoryObj } from "@storybook/react";
import { Activity, DollarSign, TrendingUp, Users } from "lucide-react";
import { DashboardStatCard } from "./dashboard-stat-card";

const meta: Meta<typeof DashboardStatCard> = {
  title: "Brand/DashboardStatCard",
  component: DashboardStatCard,
  parameters: { backgrounds: { default: "dark" } },
  decorators: [
    (Story) => (
      <div style={{ maxWidth: 320, padding: 16 }}>
        <Story />
      </div>
    ),
  ],
};
export default meta;
type Story = StoryObj<typeof DashboardStatCard>;

export const Default: Story = {
  args: {
    label: "Total Users",
    value: "1,234",
    icon: <Users className="h-5 w-5" />,
  },
};

export const WithAccent: Story = {
  args: {
    label: "Revenue",
    value: "$12,345",
    icon: <DollarSign className="h-5 w-5" />,
    accent: "emerald",
  },
};

export const WithHelper: Story = {
  args: {
    label: "Active Sessions",
    value: "89",
    icon: <Activity className="h-5 w-5" />,
    accent: "orange",
    helper: "+12% from last week",
  },
};

export const AllAccents: Story = {
  render: () => (
    <div style={{ display: "grid", gap: 12 }}>
      {(["orange", "amber", "blue", "emerald", "red", "violet", "white"] as const).map((accent) => (
        <DashboardStatCard
          key={accent}
          label={accent}
          value="42"
          accent={accent}
          icon={<TrendingUp className="h-5 w-5" />}
        />
      ))}
    </div>
  ),
};
