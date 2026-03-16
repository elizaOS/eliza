import type { Meta, StoryObj } from "@storybook/react";
import React from "react";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "../components/ui/tabs";

const meta: Meta<typeof Tabs> = { title: "Molecules/Tabs", component: Tabs };
export default meta;

export const Default: StoryObj = {
  render: () => (
    <Tabs defaultValue="chat" className="w-96">
      <TabsList>
        <TabsTrigger value="chat">Chat</TabsTrigger>
        <TabsTrigger value="voice">Voice</TabsTrigger>
        <TabsTrigger value="logs">Logs</TabsTrigger>
      </TabsList>
      <TabsContent value="chat" className="p-4 text-sm">
        Live agent chat interface.
      </TabsContent>
      <TabsContent value="voice" className="p-4 text-sm">
        Voice call controls.
      </TabsContent>
      <TabsContent value="logs" className="p-4 text-sm">
        Activity stream.
      </TabsContent>
    </Tabs>
  ),
};
