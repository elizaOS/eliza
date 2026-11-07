/**
 * Story group for the cloud dashboard compositions (empty states, cards, skeletons).
 */

import type { Meta, StoryObj } from "@storybook/react";
import { Plus } from "lucide-react";
import {
  AppsEmptyState,
  AppsSkeleton,
  ContainersEmptyState,
  ContainersSkeleton,
  DashboardActionCards,
  DashboardActionCardsSkeleton,
} from "../../cloud-ui/components/dashboard/cloud-dashboard-components.tsx";
import { Button } from "../../components/ui/button.tsx";
import { ThemeComparison } from "./ThemeComparison";

export default {
  title: "Comparisons/Cloud Dashboard",
  parameters: { layout: "fullscreen" },
} satisfies Meta;

export const CloudDashboardActionCards: StoryObj = {
  render: () => (
    <ThemeComparison
      story={{
        id: "cloud-dashboard-action-cards",
        name: "DashboardActionCards",
        importPath: 'import { DashboardActionCards } from "@elizaos/ui"',
        description:
          "Primary Eliza Cloud dashboard action grid. Apps can inject SPA routing through renderLink.",
        render: () => (
          <div style={{ width: "100%" }}>
            <DashboardActionCards creditBalance={12.34} />
          </div>
        ),
      }}
    />
  ),
};

export const CloudDashboardActionCardsSkeleton: StoryObj = {
  render: () => (
    <ThemeComparison
      story={{
        id: "cloud-dashboard-action-cards-skeleton",
        name: "DashboardActionCardsSkeleton",
        importPath:
          'import { DashboardActionCardsSkeleton } from "@elizaos/ui"',
        render: () => (
          <div style={{ width: "100%" }}>
            <DashboardActionCardsSkeleton />
          </div>
        ),
      }}
    />
  ),
};

export const CloudAppsEmptyState: StoryObj = {
  render: () => (
    <ThemeComparison
      story={{
        id: "cloud-apps-empty-state",
        name: "AppsEmptyState",
        importPath: 'import { AppsEmptyState } from "@elizaos/ui"',
        render: () => (
          <div style={{ width: "100%" }}>
            <AppsEmptyState
              action={
                <Button size="sm">
                  <Plus className="h-4 w-4" />
                  Register app
                </Button>
              }
            />
          </div>
        ),
      }}
    />
  ),
};

export const CloudAppsSkeleton: StoryObj = {
  render: () => (
    <ThemeComparison
      story={{
        id: "cloud-apps-skeleton",
        name: "AppsSkeleton",
        importPath: 'import { AppsSkeleton } from "@elizaos/ui"',
        render: () => (
          <div style={{ width: "100%" }}>
            <AppsSkeleton />
          </div>
        ),
      }}
    />
  ),
};

export const CloudContainersEmptyState: StoryObj = {
  render: () => (
    <ThemeComparison
      story={{
        id: "cloud-containers-empty-state",
        name: "ContainersEmptyState",
        importPath: 'import { ContainersEmptyState } from "@elizaos/ui"',
        render: () => (
          <div style={{ width: "100%" }}>
            <ContainersEmptyState />
          </div>
        ),
      }}
    />
  ),
};

export const CloudContainersSkeleton: StoryObj = {
  render: () => (
    <ThemeComparison
      story={{
        id: "cloud-containers-skeleton",
        name: "ContainersSkeleton",
        importPath: 'import { ContainersSkeleton } from "@elizaos/ui"',
        render: () => (
          <div style={{ width: "100%" }}>
            <ContainersSkeleton />
          </div>
        ),
      }}
    />
  ),
};
