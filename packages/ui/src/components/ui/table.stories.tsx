import type { Meta, StoryObj } from "@storybook/react";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "./table";

const meta = {
  title: "Primitives/Table",
  component: Table,
  tags: ["autodocs"],
} satisfies Meta<typeof Table>;

export default meta;
type Story = StoryObj<typeof meta>;

const agents = [
  { name: "Eliza", model: "claude-opus-4", status: "Online", messages: 1280 },
  { name: "Scout", model: "gpt-4o-mini", status: "Idle", messages: 342 },
  { name: "Archivist", model: "llama-3.1-8b", status: "Offline", messages: 57 },
];

export const Default: Story = {
  render: (args) => (
    <Table {...args} className="w-[32rem]">
      <TableHeader>
        <TableRow>
          <TableHead>Agent</TableHead>
          <TableHead>Model</TableHead>
          <TableHead>Status</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {agents.map((agent) => (
          <TableRow key={agent.name}>
            <TableCell>{agent.name}</TableCell>
            <TableCell>{agent.model}</TableCell>
            <TableCell>{agent.status}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  ),
};

export const WithFooter: Story = {
  render: (args) => (
    <Table {...args} className="w-[32rem]">
      <TableHeader>
        <TableRow>
          <TableHead>Agent</TableHead>
          <TableHead className="text-right">Messages</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {agents.map((agent) => (
          <TableRow key={agent.name}>
            <TableCell>{agent.name}</TableCell>
            <TableCell className="text-right">{agent.messages}</TableCell>
          </TableRow>
        ))}
      </TableBody>
      <TableFooter>
        <TableRow>
          <TableCell>Total</TableCell>
          <TableCell className="text-right">
            {agents.reduce((sum, agent) => sum + agent.messages, 0)}
          </TableCell>
        </TableRow>
      </TableFooter>
    </Table>
  ),
};

export const WithCaption: Story = {
  render: (args) => (
    <Table {...args} className="w-[32rem]">
      <TableCaption>Active agents in this workspace.</TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead>Agent</TableHead>
          <TableHead>Model</TableHead>
          <TableHead>Status</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {agents.map((agent) => (
          <TableRow key={agent.name}>
            <TableCell>{agent.name}</TableCell>
            <TableCell>{agent.model}</TableCell>
            <TableCell>{agent.status}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  ),
};

export const SelectedRow: Story = {
  render: (args) => (
    <Table {...args} className="w-[32rem]">
      <TableHeader>
        <TableRow>
          <TableHead>Agent</TableHead>
          <TableHead>Model</TableHead>
          <TableHead>Status</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {agents.map((agent, index) => (
          <TableRow
            key={agent.name}
            data-state={index === 0 ? "selected" : undefined}
          >
            <TableCell>{agent.name}</TableCell>
            <TableCell>{agent.model}</TableCell>
            <TableCell>{agent.status}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  ),
};
