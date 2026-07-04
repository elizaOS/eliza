/**
 * Storybook stories for the BrandTabs cloud brand tab set.
 */
import type { Meta, StoryObj } from "@storybook/react";
import * as React from "react";
import {
  BrandTabs,
  BrandTabsContent,
  BrandTabsList,
  BrandTabsTrigger,
  SimpleBrandTabs,
} from "./brand-tabs";

const meta = {
  title: "CloudUI/Brand/BrandTabs",
  component: BrandTabs,
  tags: ["autodocs"],
} satisfies Meta<typeof BrandTabs>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => (
    <BrandTabs defaultValue="overview" className="w-[520px]">
      <BrandTabsList>
        <BrandTabsTrigger value="overview">Overview</BrandTabsTrigger>
        <BrandTabsTrigger value="activity">Activity</BrandTabsTrigger>
        <BrandTabsTrigger value="settings">Settings</BrandTabsTrigger>
      </BrandTabsList>
      <BrandTabsContent value="overview">
        <p className="text-sm text-txt/80">
          Summary metrics, recent runs, and quick actions for the workspace.
        </p>
      </BrandTabsContent>
      <BrandTabsContent value="activity">
        <p className="text-sm text-txt/80">
          A timeline of agent invocations, tool calls, and webhooks.
        </p>
      </BrandTabsContent>
      <BrandTabsContent value="settings">
        <p className="text-sm text-txt/80">
          Configure billing, members, API keys, and integrations.
        </p>
      </BrandTabsContent>
    </BrandTabs>
  ),
};

export const TwoTabs: Story = {
  render: () => (
    <BrandTabs defaultValue="json" className="w-[420px]">
      <BrandTabsList>
        <BrandTabsTrigger value="json">JSON</BrandTabsTrigger>
        <BrandTabsTrigger value="curl">cURL</BrandTabsTrigger>
      </BrandTabsList>
      <BrandTabsContent value="json">
        <pre className="rounded-sm border border-border bg-bg-elevated p-3 text-xs">
          {JSON.stringify({ ok: true, id: "msg_01H" }, null, 2)}
        </pre>
      </BrandTabsContent>
      <BrandTabsContent value="curl">
        <pre className="rounded-sm border border-border bg-bg-elevated p-3 text-xs">
          {
            "curl https://api.elizaos.ai/v1/messages \\\n  -H 'Authorization: Bearer …'"
          }
        </pre>
      </BrandTabsContent>
    </BrandTabs>
  ),
};

export const WithDisabled: Story = {
  render: () => (
    <BrandTabs defaultValue="live" className="w-[480px]">
      <BrandTabsList>
        <BrandTabsTrigger value="live">Live</BrandTabsTrigger>
        <BrandTabsTrigger value="draft">Draft</BrandTabsTrigger>
        <BrandTabsTrigger value="archived" disabled>
          Archived
        </BrandTabsTrigger>
      </BrandTabsList>
      <BrandTabsContent value="live">
        <p className="text-sm text-txt/80">
          3 agents currently serving traffic.
        </p>
      </BrandTabsContent>
      <BrandTabsContent value="draft">
        <p className="text-sm text-txt/80">
          Unpublished changes waiting for review.
        </p>
      </BrandTabsContent>
    </BrandTabs>
  ),
};

export const SimpleVariant: Story = {
  render: () => {
    const tabs = ["All", "Mentions", "Errors", "Tools"];
    const [active, setActive] = React.useState("All");
    return (
      <div className="w-[520px]">
        <SimpleBrandTabs
          tabs={tabs}
          activeTab={active}
          onTabChange={setActive}
        />
        <p className="mt-4 text-sm text-txt/70">Active filter: {active}</p>
      </div>
    );
  },
};

export const SimpleVariantManyTabs: Story = {
  render: () => {
    const tabs = [
      "Inbox",
      "Threads",
      "Drafts",
      "Sent",
      "Scheduled",
      "Spam",
      "Trash",
    ];
    const [active, setActive] = React.useState("Inbox");
    return (
      <div className="w-[640px]">
        <SimpleBrandTabs
          tabs={tabs}
          activeTab={active}
          onTabChange={setActive}
        />
      </div>
    );
  },
};
