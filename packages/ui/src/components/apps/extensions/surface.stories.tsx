/**
 * Storybook stories for the detail-extension surface primitives: sections,
 * card grids, empty states, and mixed canonical compositions.
 */

import type { Meta, StoryObj } from "@storybook/react";
import { StatusBadge } from "../../ui/status-badge";
import {
  SurfaceCard,
  SurfaceEmptyState,
  SurfaceGrid,
  SurfaceSection,
} from "./surface";

const meta = {
  title: "Apps/Extensions/Surface",
  component: SurfaceSection,
  tags: ["autodocs"],
  argTypes: {
    title: { control: "text" },
  },
  args: {
    title: "Recent runs",
  },
} satisfies Meta<typeof SurfaceSection>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Section: Story = {
  args: {
    children: (
      <SurfaceGrid>
        <SurfaceCard
          label="Status"
          value="Healthy"
          tone="success"
          subtitle="Last checked 2 minutes ago"
        />
        <SurfaceCard
          label="Latency"
          value="142 ms"
          tone="accent"
          subtitle="p95 across the last 100 runs"
        />
      </SurfaceGrid>
    ),
  },
};

export const CardGrid: Story = {
  args: {
    title: "Run summary",
    children: (
      <SurfaceGrid>
        <SurfaceCard label="Runs" value="1,248" tone="neutral" />
        <SurfaceCard
          label="Errors"
          value="3"
          tone="danger"
          subtitle="2 timeouts, 1 rate limit"
        />
        <SurfaceCard
          label="Warnings"
          value="12"
          tone="warn"
          subtitle="Mostly retry-recovered"
        />
        <SurfaceCard
          label="Avg duration"
          value="842 ms"
          tone="accent"
          subtitle="Down 6% from last week"
        />
      </SurfaceGrid>
    ),
  },
};

export const WithEmptyState: Story = {
  args: {
    title: "Extensions",
    children: (
      <SurfaceEmptyState
        title="No extensions installed"
        body="Install an extension from the marketplace to surface its activity here."
      />
    ),
  },
};

export const MixedContent: Story = {
  args: {
    title: "Extension overview",
    children: (
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge label="Active" tone="success" />
          <StatusBadge label="v2.4.1" tone="info" />
          <StatusBadge label="Background" tone="muted" />
        </div>
        <SurfaceGrid>
          <SurfaceCard
            label="Triggers"
            value="48 today"
            tone="accent"
            subtitle="Peaked at 11:00"
          />
          <SurfaceCard
            label="Failures"
            value="0"
            tone="success"
            subtitle="Clean run streak: 14 days"
          />
        </SurfaceGrid>
      </div>
    ),
  },
};
