import type { Meta, StoryObj } from "@storybook/react";
import { Bar, BarChart, CartesianGrid, Line, LineChart, XAxis } from "recharts";
import type { ChartConfig } from "./chart";
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
} from "./chart";

const data = [
  { month: "Jan", desktop: 186, mobile: 80 },
  { month: "Feb", desktop: 305, mobile: 200 },
  { month: "Mar", desktop: 237, mobile: 120 },
  { month: "Apr", desktop: 73, mobile: 190 },
  { month: "May", desktop: 209, mobile: 130 },
  { month: "Jun", desktop: 214, mobile: 140 },
];

const config = {
  desktop: { label: "Desktop", color: "hsl(220 70% 50%)" },
  mobile: { label: "Mobile", color: "hsl(160 60% 45%)" },
} satisfies ChartConfig;

const meta = {
  title: "Primitives/Chart",
  component: ChartContainer,
  tags: ["autodocs"],
  args: { config },
  render: (args) => (
    <ChartContainer {...args} className="h-[300px] w-[600px]">
      <BarChart data={data}>
        <CartesianGrid vertical={false} />
        <XAxis dataKey="month" tickLine={false} axisLine={false} />
        <ChartTooltip content={<ChartTooltipContent />} />
        <ChartLegend content={<ChartLegendContent />} />
        <Bar dataKey="desktop" fill="var(--color-desktop)" radius={4} />
        <Bar dataKey="mobile" fill="var(--color-mobile)" radius={4} />
      </BarChart>
    </ChartContainer>
  ),
} satisfies Meta<typeof ChartContainer>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const LineWithTooltip: Story = {
  render: (args) => (
    <ChartContainer {...args} className="h-[300px] w-[600px]">
      <LineChart data={data}>
        <CartesianGrid vertical={false} />
        <XAxis dataKey="month" tickLine={false} axisLine={false} />
        <ChartTooltip content={<ChartTooltipContent indicator="line" />} />
        <Line
          dataKey="desktop"
          stroke="var(--color-desktop)"
          strokeWidth={2}
          dot={false}
        />
        <Line
          dataKey="mobile"
          stroke="var(--color-mobile)"
          strokeWidth={2}
          dot={false}
        />
      </LineChart>
    </ChartContainer>
  ),
};

export const SingleSeries: Story = {
  args: {
    config: {
      desktop: { label: "Desktop", color: "hsl(280 65% 55%)" },
    } satisfies ChartConfig,
  },
  render: (args) => (
    <ChartContainer {...args} className="h-[300px] w-[600px]">
      <BarChart data={data}>
        <CartesianGrid vertical={false} />
        <XAxis dataKey="month" tickLine={false} axisLine={false} />
        <ChartTooltip content={<ChartTooltipContent hideLabel />} />
        <Bar dataKey="desktop" fill="var(--color-desktop)" radius={4} />
      </BarChart>
    </ChartContainer>
  ),
};
