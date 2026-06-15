import type { Meta, StoryObj } from "@storybook/react";
import type { UiSpec } from "../../config/ui-spec";
import { withMockApp } from "../../storybook/mock-providers.helpers";
import { UiRenderer } from "./ui-renderer";

const formSpec: UiSpec = {
  root: "root",
  state: {
    profile: { name: "Ada Lovelace", bio: "Mathematician & programmer." },
    notifications: true,
    plan: "pro",
  },
  elements: {
    root: {
      type: "Card",
      props: { title: "Profile", description: "Update your account details." },
      children: ["stack"],
    },
    stack: {
      type: "Stack",
      props: { direction: "vertical", gap: "md" },
      children: ["name", "bio", "plan", "notify", "save"],
    },
    name: {
      type: "Input",
      props: {
        label: "Display name",
        statePath: "profile.name",
        placeholder: "Your name",
      },
      children: [],
    },
    bio: {
      type: "Textarea",
      props: {
        label: "Bio",
        statePath: "profile.bio",
        rows: 3,
        placeholder: "A short bio...",
      },
      children: [],
    },
    plan: {
      type: "Select",
      props: {
        label: "Plan",
        statePath: "plan",
        options: [
          { label: "Free", value: "free" },
          { label: "Pro", value: "pro" },
          { label: "Team", value: "team" },
        ],
      },
      children: [],
    },
    notify: {
      type: "Checkbox",
      props: { label: "Email notifications", statePath: "notifications" },
      children: [],
    },
    save: {
      type: "Button",
      props: { label: "Save changes", variant: "primary" },
      children: [],
      on: { press: { action: "save" } },
    },
  },
};

const dashboardSpec: UiSpec = {
  root: "root",
  state: {},
  elements: {
    root: {
      type: "Stack",
      props: { direction: "vertical", gap: "lg" },
      children: ["heading", "metrics", "alert", "progress"],
    },
    heading: {
      type: "Heading",
      props: { text: "Weekly overview", level: "h1" },
      children: [],
    },
    metrics: {
      type: "Grid",
      props: { columns: 3, gap: "md" },
      children: ["m1", "m2", "m3"],
    },
    m1: {
      type: "Metric",
      props: { label: "Users", value: "1,284", change: "+12%", trend: "up" },
      children: [],
    },
    m2: {
      type: "Metric",
      props: {
        label: "Revenue",
        value: "$8,420",
        change: "-3%",
        trend: "down",
      },
      children: [],
    },
    m3: {
      type: "Metric",
      props: { label: "Latency", value: "127", unit: "ms", trend: "flat" },
      children: [],
    },
    alert: {
      type: "Alert",
      props: {
        type: "info",
        title: "Heads up",
        message: "Maintenance window scheduled for Sunday at 02:00 UTC.",
      },
      children: [],
    },
    progress: {
      type: "Progress",
      props: { label: "Quota used", value: 72, max: 100 },
      children: [],
    },
  },
};

const emptySpec: UiSpec = { root: "root", state: {}, elements: {} };

const meta = {
  title: "ConfigUi/UiRenderer",
  component: UiRenderer,
  tags: ["autodocs"],
  decorators: [withMockApp],
  argTypes: {
    loading: { control: "boolean" },
    onAction: { action: "action" },
  },
  args: {
    spec: formSpec,
    loading: false,
    onAction: () => {},
  },
} satisfies Meta<typeof UiRenderer>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Form: Story = {};

export const Dashboard: Story = {
  args: { spec: dashboardSpec },
};

export const LoadingSkeleton: Story = {
  args: { spec: emptySpec, loading: true },
};

export const UnauthenticatedVisibility: Story = {
  args: {
    spec: formSpec,
    auth: { isSignedIn: false },
  },
};
