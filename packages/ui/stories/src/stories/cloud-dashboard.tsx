/**
 * Story group for the cloud dashboard compositions (empty states, cards, skeletons).
 */
import { BrandButton } from "@ui-src/cloud-ui/components/brand/brand-button.tsx";
import {
  AppsEmptyState,
  AppsSkeleton,
  ContainersEmptyState,
  ContainersSkeleton,
  DashboardActionCards,
  DashboardActionCardsSkeleton,
} from "@ui-src/cloud-ui/components/dashboard/cloud-dashboard-components.tsx";
import { Plus } from "lucide-react";
import type { StoryDefinition } from "../Story.tsx";

export const cloudDashboardStories: StoryDefinition[] = [
  {
    id: "cloud-dashboard-action-cards",
    name: "DashboardActionCards",
    importPath:
      'import { DashboardActionCards } from "@elizaos/ui/cloud-ui/components/dashboard/cloud-dashboard-components"',
    description:
      "Primary Eliza Cloud dashboard action grid. Apps can inject SPA routing through renderLink.",
    render: () => (
      <div style={{ width: "100%" }}>
        <DashboardActionCards creditBalance={12.34} />
      </div>
    ),
  },
  {
    id: "cloud-dashboard-action-cards-skeleton",
    name: "DashboardActionCardsSkeleton",
    importPath:
      'import { DashboardActionCardsSkeleton } from "@elizaos/ui/cloud-ui/components/dashboard/cloud-dashboard-components"',
    render: () => (
      <div style={{ width: "100%" }}>
        <DashboardActionCardsSkeleton />
      </div>
    ),
  },
  {
    id: "cloud-apps-empty-state",
    name: "AppsEmptyState",
    importPath:
      'import { AppsEmptyState } from "@elizaos/ui/cloud-ui/components/dashboard/cloud-dashboard-components"',
    render: () => (
      <div style={{ width: "100%" }}>
        <AppsEmptyState
          action={
            <BrandButton size="sm">
              <Plus className="h-4 w-4" />
              Register app
            </BrandButton>
          }
        />
      </div>
    ),
  },
  {
    id: "cloud-apps-skeleton",
    name: "AppsSkeleton",
    importPath:
      'import { AppsSkeleton } from "@elizaos/ui/cloud-ui/components/dashboard/cloud-dashboard-components"',
    render: () => (
      <div style={{ width: "100%" }}>
        <AppsSkeleton />
      </div>
    ),
  },
  {
    id: "cloud-containers-empty-state",
    name: "ContainersEmptyState",
    importPath:
      'import { ContainersEmptyState } from "@elizaos/ui/cloud-ui/components/dashboard/cloud-dashboard-components"',
    render: () => (
      <div style={{ width: "100%" }}>
        <ContainersEmptyState />
      </div>
    ),
  },
  {
    id: "cloud-containers-skeleton",
    name: "ContainersSkeleton",
    importPath:
      'import { ContainersSkeleton } from "@elizaos/ui/cloud-ui/components/dashboard/cloud-dashboard-components"',
    render: () => (
      <div style={{ width: "100%" }}>
        <ContainersSkeleton />
      </div>
    ),
  },
];
