/**
 * Storybook stories for DashboardRoutePage.
 */
import type { Meta, StoryObj } from "@storybook/react";
import type { ReactNode } from "react";
import { DashboardRoutePage } from "./dashboard-route-page";
import { PageHeaderProvider } from "./page-header-context";
import { usePageHeader } from "./page-header-context.hooks";

function PageHeaderPreview() {
  const { pageInfo } = usePageHeader();
  if (!pageInfo) return null;
  return (
    <header className="mb-6 border-b border-white/10 pb-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-white">
            {pageInfo.title}
          </h1>
          {pageInfo.description ? (
            <p className="mt-1 text-sm text-white/60">{pageInfo.description}</p>
          ) : null}
        </div>
        {pageInfo.actions ? <div>{pageInfo.actions}</div> : null}
      </div>
    </header>
  );
}

function StoryShell({ children }: { children: ReactNode }) {
  return (
    <PageHeaderProvider>
      <div className="min-h-screen bg-neutral-950 p-6 text-white">
        <PageHeaderPreview />
        {children}
      </div>
    </PageHeaderProvider>
  );
}

const sampleContent = (
  <div className="grid gap-4 sm:grid-cols-2">
    <div className="border border-white/10 bg-white/5 p-4">
      <h3 className="text-sm font-semibold text-white">Recent activity</h3>
      <p className="mt-2 text-sm text-white/60">
        12 events in the last 24 hours. All systems nominal.
      </p>
    </div>
    <div className="border border-white/10 bg-white/5 p-4">
      <h3 className="text-sm font-semibold text-white">Usage</h3>
      <p className="mt-2 text-sm text-white/60">
        43% of monthly quota consumed.
      </p>
    </div>
  </div>
);

const meta = {
  title: "CloudUI/Layout/DashboardRoutePage",
  component: DashboardRoutePage,
  tags: ["autodocs"],
  decorators: [
    (Story) => (
      <StoryShell>
        <Story />
      </StoryShell>
    ),
  ],
  args: {
    title: "Overview",
    description: "A quick look at your workspace.",
    container: true,
    stack: true,
    children: sampleContent,
  },
} satisfies Meta<typeof DashboardRoutePage>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const WithActions: Story = {
  args: {
    title: "Agents",
    description: "Manage and deploy your autonomous agents.",
    actions: (
      <button
        type="button"
        className="border border-orange-400/40 bg-orange-400/10 px-3 py-1.5 text-sm text-orange-200 hover:bg-orange-400/20"
        onClick={() => {}}
      >
        New agent
      </button>
    ),
  },
};

export const InfoBanner: Story = {
  args: {
    title: "Billing",
    description: "Review your plan and upcoming invoice.",
    banner: "Your next invoice will be issued on the 28th.",
    bannerTone: "info",
  },
};

export const WarningBanner: Story = {
  args: {
    title: "Integrations",
    description: "Connect external services to your workspace.",
    banner: "One of your integrations is using a deprecated API version.",
    bannerTone: "warning",
  },
};

export const ErrorBanner: Story = {
  args: {
    title: "Deployments",
    description: "Promote builds across environments.",
    banner: "Last deployment failed — check the logs for details.",
    bannerTone: "error",
  },
};

export const NarrowContainer: Story = {
  args: {
    title: "Settings",
    description: "Adjust workspace-wide preferences.",
    container: { width: "narrow" },
    children: (
      <div className="border border-white/10 bg-white/5 p-6">
        <h3 className="text-sm font-semibold text-white">Workspace name</h3>
        <p className="mt-2 text-sm text-white/60">
          Visible to all members of your team.
        </p>
        <div className="mt-4 border border-white/10 bg-neutral-900 px-3 py-2 text-sm">
          Acme Robotics
        </div>
      </div>
    ),
  },
};
