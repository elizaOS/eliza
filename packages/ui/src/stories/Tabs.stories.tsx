import type { Meta, StoryObj } from "@storybook/react";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "../components/ui/tabs";

const meta = {
  title: "UI/Tabs",
  component: Tabs,
  tags: ["autodocs"],
} satisfies Meta<typeof Tabs>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => (
    <Tabs defaultValue="tab1" className="w-[400px]">
      <TabsList>
        <TabsTrigger value="tab1">Account</TabsTrigger>
        <TabsTrigger value="tab2">Password</TabsTrigger>
        <TabsTrigger value="tab3">Settings</TabsTrigger>
      </TabsList>
      <TabsContent value="tab1">
        <p className="text-sm text-muted p-4">
          Manage your account settings and preferences.
        </p>
      </TabsContent>
      <TabsContent value="tab2">
        <p className="text-sm text-muted p-4">
          Change your password and security options.
        </p>
      </TabsContent>
      <TabsContent value="tab3">
        <p className="text-sm text-muted p-4">
          Configure application settings.
        </p>
      </TabsContent>
    </Tabs>
  ),
};

export const SecondTabActive: Story = {
  render: () => (
    <Tabs defaultValue="tab2" className="w-[400px]">
      <TabsList>
        <TabsTrigger value="tab1">Overview</TabsTrigger>
        <TabsTrigger value="tab2">Analytics</TabsTrigger>
        <TabsTrigger value="tab3">Reports</TabsTrigger>
      </TabsList>
      <TabsContent value="tab1">
        <p className="text-sm text-muted p-4">Overview content.</p>
      </TabsContent>
      <TabsContent value="tab2">
        <p className="text-sm text-muted p-4">Analytics content.</p>
      </TabsContent>
      <TabsContent value="tab3">
        <p className="text-sm text-muted p-4">Reports content.</p>
      </TabsContent>
    </Tabs>
  ),
};
