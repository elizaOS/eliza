import type { Meta, StoryObj } from "@storybook/react";
import type { ComponentType, ReactNode } from "react";
import type {
  AppBootStewardPendingApproval,
  StewardApprovalQueueProps,
  StewardLogoProps,
  StewardTransactionHistoryProps,
} from "../../config/boot-config";
import { AppBootContext } from "../../config/boot-config-react.hooks";
import {
  type AppBootConfig,
  DEFAULT_BOOT_CONFIG,
} from "../../config/boot-config-store";
import { ApprovalQueue, StewardLogo, TransactionHistory } from "./injected";

const MockStewardLogo: ComponentType<StewardLogoProps> = ({
  size = 32,
  className,
}) => (
  <div
    className={className}
    style={{
      width: size,
      height: size,
      borderRadius: 8,
      background: "linear-gradient(135deg, #f97316, #dc2626)",
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      color: "white",
      fontWeight: 700,
      fontSize: Math.max(10, Math.floor(size / 2.4)),
    }}
  >
    S
  </div>
);

const MOCK_PENDING: AppBootStewardPendingApproval[] = [
  {
    queueId: "queue-1",
    status: "pending",
    requestedAt: new Date().toISOString(),
    transaction: {
      id: "tx-1",
      agentId: "agent-alpha",
      status: "pending",
      request: {
        agentId: "agent-alpha",
        tenantId: "tenant-1",
        to: "0xAbCdEf0123456789abcdef0123456789AbCdEf01",
        value: "0.05",
        chainId: 1,
      },
      policyResults: [],
      createdAt: new Date().toISOString(),
    },
  },
];

const MockApprovalQueue: ComponentType<StewardApprovalQueueProps> = ({
  embedded,
}) => (
  <div
    style={{
      border: "1px solid #e5e7eb",
      borderRadius: 8,
      padding: 16,
      background: embedded ? "transparent" : "#fafafa",
      fontFamily: "system-ui, sans-serif",
    }}
  >
    <div style={{ fontWeight: 600, marginBottom: 8 }}>Approval Queue</div>
    {MOCK_PENDING.map((p) => (
      <div key={p.queueId} style={{ fontSize: 13, color: "#374151" }}>
        Send {p.transaction.request.value} ETH to{" "}
        {p.transaction.request.to.slice(0, 10)}…
      </div>
    ))}
  </div>
);

const MockTransactionHistory: ComponentType<StewardTransactionHistoryProps> = ({
  embedded,
}) => (
  <div
    style={{
      border: "1px solid #e5e7eb",
      borderRadius: 8,
      padding: 16,
      background: embedded ? "transparent" : "#fafafa",
      fontFamily: "system-ui, sans-serif",
      fontSize: 13,
      color: "#374151",
    }}
  >
    <div style={{ fontWeight: 600, marginBottom: 8 }}>Transaction History</div>
    <div>0xdead…beef · confirmed · 0.10 ETH</div>
    <div>0xfeed…face · pending · 0.05 ETH</div>
  </div>
);

const noopApprovalProps: StewardApprovalQueueProps = {
  getStewardPending: async () => MOCK_PENDING,
  approveStewardTx: async () => ({ ok: true }),
  rejectStewardTx: async () => ({ ok: true }),
  copyToClipboard: async () => {},
  setActionNotice: () => {},
};

const noopHistoryProps: StewardTransactionHistoryProps = {
  getStewardHistory: async () => ({
    records: [],
    total: 0,
    offset: 0,
    limit: 25,
  }),
  copyToClipboard: async () => {},
  setActionNotice: () => {},
};

function withBootConfig(overrides: Partial<AppBootConfig>) {
  return (Story: () => ReactNode) => (
    <AppBootContext.Provider value={{ ...DEFAULT_BOOT_CONFIG, ...overrides }}>
      <Story />
    </AppBootContext.Provider>
  );
}

const meta = {
  title: "Steward/Injected",
  component: StewardLogo,
  tags: ["autodocs"],
  parameters: {
    docs: {
      description: {
        component:
          "Thin wrappers that resolve host-provided Steward components from the boot config. Each renders `null` when the host has not injected an implementation.",
      },
    },
  },
} satisfies Meta<typeof StewardLogo>;

export default meta;
type Story = StoryObj<typeof meta>;

export const LogoDefault: Story = {
  args: { size: 40 },
  decorators: [withBootConfig({ stewardLogo: MockStewardLogo })],
};

export const LogoSmall: Story = {
  args: { size: 16 },
  decorators: [withBootConfig({ stewardLogo: MockStewardLogo })],
};

export const LogoNotConfigured: Story = {
  args: { size: 40 },
  parameters: {
    docs: {
      description: {
        story:
          "Without a host-provided `stewardLogo`, the wrapper renders nothing.",
      },
    },
  },
};

export const ApprovalQueueInjected: StoryObj = {
  render: () => (
    <ApprovalQueue {...noopApprovalProps} refreshKey={0} embedded />
  ),
  decorators: [withBootConfig({ stewardApprovalQueue: MockApprovalQueue })],
};

export const TransactionHistoryInjected: StoryObj = {
  render: () => <TransactionHistory {...noopHistoryProps} embedded />,
  decorators: [
    withBootConfig({ stewardTransactionHistory: MockTransactionHistory }),
  ],
};
