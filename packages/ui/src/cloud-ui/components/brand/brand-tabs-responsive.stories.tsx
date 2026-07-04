/**
 * Storybook stories for the responsive BrandTabs variant.
 */
import type { Meta, StoryObj } from "@storybook/react";
import * as React from "react";
import { BrandTabsContent } from "./brand-tabs";
import { BrandTabsResponsive } from "./brand-tabs-responsive";

const HomeIcon = () => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    aria-hidden="true"
  >
    <path d="M3 9.5L12 3l9 6.5V21H3z" />
  </svg>
);
const ChartIcon = () => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    aria-hidden="true"
  >
    <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />
  </svg>
);
const SettingsIcon = () => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    aria-hidden="true"
  >
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3h0a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9v0a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
  </svg>
);
const InboxIcon = () => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    aria-hidden="true"
  >
    <path d="M22 12h-6l-2 3h-4l-2-3H2" />
    <path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
  </svg>
);

const sampleTabs = [
  { value: "overview", label: "Overview", icon: <HomeIcon /> },
  { value: "analytics", label: "Analytics", icon: <ChartIcon /> },
  { value: "inbox", label: "Inbox", icon: <InboxIcon /> },
  { value: "settings", label: "Settings", icon: <SettingsIcon /> },
];

const PanelBody = ({ children }: { children: React.ReactNode }) => (
  <div className="mt-3 rounded-sm border border-border bg-bg-elevated p-4 text-sm text-txt">
    {children}
  </div>
);

const meta = {
  title: "CloudUI/Brand/BrandTabsResponsive",
  component: BrandTabsResponsive,
  tags: ["autodocs"],
  parameters: {
    layout: "padded",
  },
  argTypes: {
    breakpoint: { control: "select", options: ["sm", "md", "lg"] },
  },
} satisfies Meta<typeof BrandTabsResponsive>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    id: "brand-tabs-default",
    tabs: sampleTabs,
    defaultValue: "overview",
    breakpoint: "md",
    children: (
      <>
        <BrandTabsContent value="overview">
          <PanelBody>Overview content — usage summary, key metrics.</PanelBody>
        </BrandTabsContent>
        <BrandTabsContent value="analytics">
          <PanelBody>Analytics content — charts and trends.</PanelBody>
        </BrandTabsContent>
        <BrandTabsContent value="inbox">
          <PanelBody>Inbox content — incoming events and alerts.</PanelBody>
        </BrandTabsContent>
        <BrandTabsContent value="settings">
          <PanelBody>
            Settings content — preferences and integrations.
          </PanelBody>
        </BrandTabsContent>
      </>
    ),
  },
};

export const Controlled: Story = {
  render: (args) => {
    const [value, setValue] = React.useState("analytics");
    return (
      <BrandTabsResponsive {...args} value={value} onValueChange={setValue}>
        <BrandTabsContent value="overview">
          <PanelBody>Selected: overview</PanelBody>
        </BrandTabsContent>
        <BrandTabsContent value="analytics">
          <PanelBody>Selected: analytics</PanelBody>
        </BrandTabsContent>
        <BrandTabsContent value="inbox">
          <PanelBody>Selected: inbox</PanelBody>
        </BrandTabsContent>
        <BrandTabsContent value="settings">
          <PanelBody>Selected: settings</PanelBody>
        </BrandTabsContent>
      </BrandTabsResponsive>
    );
  },
  args: {
    id: "brand-tabs-controlled",
    tabs: sampleTabs,
    breakpoint: "md",
    children: null,
  },
};

export const WithDisabledTab: Story = {
  args: {
    id: "brand-tabs-disabled",
    breakpoint: "md",
    defaultValue: "overview",
    tabs: [
      { value: "overview", label: "Overview", icon: <HomeIcon /> },
      { value: "analytics", label: "Analytics", icon: <ChartIcon /> },
      {
        value: "inbox",
        label: "Inbox (locked)",
        icon: <InboxIcon />,
        disabled: true,
      },
      { value: "settings", label: "Settings", icon: <SettingsIcon /> },
    ],
    children: (
      <>
        <BrandTabsContent value="overview">
          <PanelBody>Overview is available to all plan tiers.</PanelBody>
        </BrandTabsContent>
        <BrandTabsContent value="analytics">
          <PanelBody>Analytics dashboard.</PanelBody>
        </BrandTabsContent>
        <BrandTabsContent value="settings">
          <PanelBody>Workspace settings.</PanelBody>
        </BrandTabsContent>
      </>
    ),
  },
};

export const BreakpointSm: Story = {
  args: {
    id: "brand-tabs-sm",
    tabs: sampleTabs.slice(0, 3),
    defaultValue: "overview",
    breakpoint: "sm",
    children: (
      <>
        <BrandTabsContent value="overview">
          <PanelBody>Switches to dropdown below the sm breakpoint.</PanelBody>
        </BrandTabsContent>
        <BrandTabsContent value="analytics">
          <PanelBody>Analytics panel.</PanelBody>
        </BrandTabsContent>
        <BrandTabsContent value="inbox">
          <PanelBody>Inbox panel.</PanelBody>
        </BrandTabsContent>
      </>
    ),
  },
};

export const BreakpointLg: Story = {
  args: {
    id: "brand-tabs-lg",
    tabs: sampleTabs,
    defaultValue: "settings",
    breakpoint: "lg",
    children: (
      <>
        <BrandTabsContent value="overview">
          <PanelBody>Overview panel.</PanelBody>
        </BrandTabsContent>
        <BrandTabsContent value="analytics">
          <PanelBody>Analytics panel.</PanelBody>
        </BrandTabsContent>
        <BrandTabsContent value="inbox">
          <PanelBody>Inbox panel.</PanelBody>
        </BrandTabsContent>
        <BrandTabsContent value="settings">
          <PanelBody>Stays as a dropdown until the lg breakpoint.</PanelBody>
        </BrandTabsContent>
      </>
    ),
  },
};
