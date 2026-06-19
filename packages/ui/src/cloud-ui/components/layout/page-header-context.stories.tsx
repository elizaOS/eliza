import type { Meta, StoryObj } from "@storybook/react";
import { useEffect } from "react";
import { PageHeaderProvider } from "./page-header-context";
import { usePageHeader, useSetPageHeader } from "./page-header-context.hooks";

/**
 * The PageHeaderProvider itself renders nothing — these stories demonstrate the
 * provider by pairing it with a small inline consumer that reads the context
 * via usePageHeader, plus a child that publishes header info via
 * useSetPageHeader.
 */

function HeaderDisplay() {
  const { pageInfo } = usePageHeader();
  if (!pageInfo) {
    return (
      <div
        style={{
          padding: "12px 16px",
          border: "1px dashed #d1d5db",
          borderRadius: 8,
          color: "#6b7280",
          fontFamily: "system-ui, sans-serif",
        }}
      >
        No page header set.
      </div>
    );
  }
  return (
    <div
      style={{
        padding: "12px 16px",
        border: "1px solid #e5e7eb",
        borderRadius: 8,
        fontFamily: "system-ui, sans-serif",
      }}
    >
      <div style={{ fontSize: 18, fontWeight: 600 }}>{pageInfo.title}</div>
      {pageInfo.description ? (
        <div style={{ fontSize: 13, color: "#6b7280", marginTop: 4 }}>
          {pageInfo.description}
        </div>
      ) : null}
      {pageInfo.actions ? (
        <div style={{ marginTop: 10 }}>{pageInfo.actions}</div>
      ) : null}
    </div>
  );
}

function PageHeaderPublisher({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: React.ReactNode;
}) {
  useSetPageHeader({ title, description, actions });
  return null;
}

function ManualPublisher() {
  const { setPageInfo } = usePageHeader();
  useEffect(() => {
    setPageInfo({
      title: "Settings",
      description: "Manage your workspace preferences.",
    });
  }, [setPageInfo]);
  return null;
}

const meta = {
  title: "CloudUI/Layout/PageHeaderContext",
  component: PageHeaderProvider,
  tags: ["autodocs"],
} satisfies Meta<typeof PageHeaderProvider>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Empty: Story = {
  render: () => (
    <PageHeaderProvider>
      <HeaderDisplay />
    </PageHeaderProvider>
  ),
};

export const TitleOnly: Story = {
  render: () => (
    <PageHeaderProvider>
      <PageHeaderPublisher title="Dashboard" />
      <HeaderDisplay />
    </PageHeaderProvider>
  ),
};

export const TitleAndDescription: Story = {
  render: () => (
    <PageHeaderProvider>
      <PageHeaderPublisher
        title="Agents"
        description="Browse and manage your deployed Eliza agents."
      />
      <HeaderDisplay />
    </PageHeaderProvider>
  ),
};

export const WithActions: Story = {
  render: () => (
    <PageHeaderProvider>
      <PageHeaderPublisher
        title="Brands"
        description="Custom brands across all your workspaces."
        actions={
          <div style={{ display: "flex", gap: 8 }}>
            <button
              type="button"
              onClick={() => {}}
              style={{
                padding: "6px 12px",
                borderRadius: 6,
                border: "1px solid #e5e7eb",
                background: "white",
                cursor: "pointer",
              }}
            >
              Import
            </button>
            <button
              type="button"
              onClick={() => {}}
              style={{
                padding: "6px 12px",
                borderRadius: 6,
                border: "none",
                background: "#111827",
                color: "white",
                cursor: "pointer",
              }}
            >
              New brand
            </button>
          </div>
        }
      />
      <HeaderDisplay />
    </PageHeaderProvider>
  ),
};

export const ImperativeSetter: Story = {
  render: () => (
    <PageHeaderProvider>
      <ManualPublisher />
      <HeaderDisplay />
    </PageHeaderProvider>
  ),
};
