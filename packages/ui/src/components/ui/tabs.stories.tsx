/**
 * Storybook stories for the tabs primitive.
 */
import type { Meta, StoryObj } from "@storybook/react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./tabs";

const meta = {
  title: "Primitives/Tabs",
  component: Tabs,
  tags: ["autodocs"],
  argTypes: {
    orientation: {
      control: "inline-radio",
      options: ["horizontal", "vertical"],
    },
  },
  args: { defaultValue: "account" },
} satisfies Meta<typeof Tabs>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: (args) => (
    <Tabs {...args} className="w-[400px]">
      <TabsList>
        <TabsTrigger value="account">Account</TabsTrigger>
        <TabsTrigger value="password">Password</TabsTrigger>
      </TabsList>
      <TabsContent value="account">
        Manage your account details and profile information here.
      </TabsContent>
      <TabsContent value="password">
        Change your password and review active sessions here.
      </TabsContent>
    </Tabs>
  ),
};

export const ThreeTabs: Story = {
  args: { defaultValue: "overview" },
  render: (args) => (
    <Tabs {...args} className="w-[480px]">
      <TabsList>
        <TabsTrigger value="overview">Overview</TabsTrigger>
        <TabsTrigger value="analytics">Analytics</TabsTrigger>
        <TabsTrigger value="reports">Reports</TabsTrigger>
      </TabsList>
      <TabsContent value="overview">
        A high-level summary of your workspace activity.
      </TabsContent>
      <TabsContent value="analytics">
        Detailed charts and engagement metrics over time.
      </TabsContent>
      <TabsContent value="reports">
        Exportable reports and scheduled deliveries.
      </TabsContent>
    </Tabs>
  ),
};

export const WithDisabledTab: Story = {
  args: { defaultValue: "general" },
  render: (args) => (
    <Tabs {...args} className="w-[400px]">
      <TabsList>
        <TabsTrigger value="general">General</TabsTrigger>
        <TabsTrigger value="billing" disabled>
          Billing
        </TabsTrigger>
      </TabsList>
      <TabsContent value="general">
        General settings are available to everyone.
      </TabsContent>
      <TabsContent value="billing">
        Billing requires an upgraded plan.
      </TabsContent>
    </Tabs>
  ),
};
