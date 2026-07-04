/**
 * Storybook stories for the DashboardDataList primitives.
 */
import type { Meta, StoryObj } from "@storybook/react";
import {
  DashboardDataList,
  DashboardDataListCard,
  DashboardDataListDesktop,
  DashboardDataListFilteredCount,
  DashboardDataListMobile,
} from "./dashboard-data-list";

const meta = {
  title: "CloudUI/DataList/DashboardDataList",
  component: DashboardDataList,
  tags: ["autodocs"],
  decorators: [
    (Story) => (
      <div className="min-h-screen bg-black p-8 text-white">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof DashboardDataList>;

export default meta;
type Story = StoryObj<typeof meta>;

const sampleRows = [
  { id: "agt_01", name: "Atlas", status: "Online", region: "us-east" },
  { id: "agt_02", name: "Borealis", status: "Idle", region: "eu-west" },
  { id: "agt_03", name: "Cypress", status: "Offline", region: "us-west" },
];

export const Default: Story = {
  args: {
    children: (
      <>
        <DashboardDataListFilteredCount
          filtered={3}
          total={12}
          label="agents"
        />
        <DashboardDataListMobile>
          {sampleRows.map((row) => (
            <DashboardDataListCard key={row.id}>
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">{row.name}</span>
                <span className="text-[11px] uppercase tracking-widest text-white/40">
                  {row.status}
                </span>
              </div>
              <p className="mt-2 text-xs text-white/50">{row.region}</p>
            </DashboardDataListCard>
          ))}
        </DashboardDataListMobile>
        <DashboardDataListDesktop>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-white/10 text-left text-[11px] uppercase tracking-widest text-white/40">
                <th className="p-3">Name</th>
                <th className="p-3">Status</th>
                <th className="p-3">Region</th>
              </tr>
            </thead>
            <tbody>
              {sampleRows.map((row) => (
                <tr key={row.id} className="border-b border-white/5">
                  <td className="p-3">{row.name}</td>
                  <td className="p-3 text-white/70">{row.status}</td>
                  <td className="p-3 text-white/50">{row.region}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </DashboardDataListDesktop>
      </>
    ),
  },
};

export const FilteredCountOnly: Story = {
  args: {
    children: (
      <DashboardDataListFilteredCount
        filtered={5}
        total={48}
        label="deployments"
      />
    ),
  },
};

export const CardsList: Story = {
  args: {
    children: (
      <>
        <DashboardDataListCard>
          <h3 className="text-sm font-medium">Production cluster</h3>
          <p className="mt-1 text-xs text-white/60">
            12 agents running across 3 regions.
          </p>
        </DashboardDataListCard>
        <DashboardDataListCard>
          <h3 className="text-sm font-medium">Staging cluster</h3>
          <p className="mt-1 text-xs text-white/60">
            4 agents running in us-east only.
          </p>
        </DashboardDataListCard>
        <DashboardDataListCard>
          <h3 className="text-sm font-medium">Dev cluster</h3>
          <p className="mt-1 text-xs text-white/60">
            2 agents — ephemeral, auto-shutdown at 9pm.
          </p>
        </DashboardDataListCard>
      </>
    ),
  },
};

export const EmptyState: Story = {
  args: {
    children: (
      <>
        <DashboardDataListFilteredCount filtered={0} total={0} label="items" />
        <DashboardDataListCard>
          <p className="text-center text-sm text-white/50">
            No items match your filters.
          </p>
        </DashboardDataListCard>
      </>
    ),
  },
};
