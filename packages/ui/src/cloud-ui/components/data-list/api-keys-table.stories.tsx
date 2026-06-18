import type { Meta, StoryObj } from "@storybook/react";
import { type ApiKeyDisplay, ApiKeysTable } from "./api-keys-table";

const noop = () => {};

const baseKeys: ApiKeyDisplay[] = [
  {
    id: "key-1",
    name: "Production API",
    description: "Primary key used by the production backend.",
    keyPrefix: "sk_live_8f2a",
    status: "active",
    lastUsedAt: "2026-06-04T10:24:00Z",
    createdAt: "2026-01-12T09:00:00Z",
    usageCount: 184230,
    rateLimit: 1200,
    expiresAt: null,
  },
  {
    id: "key-2",
    name: "Staging API",
    description: "Used by the staging environment and CI smoke tests.",
    keyPrefix: "sk_test_3b91",
    status: "inactive",
    lastUsedAt: "2026-05-20T18:10:00Z",
    createdAt: "2026-02-02T12:30:00Z",
    usageCount: 9821,
    rateLimit: 600,
    expiresAt: "2026-09-01T00:00:00Z",
  },
  {
    id: "key-3",
    name: "Legacy mobile",
    description: null,
    keyPrefix: "sk_live_a013",
    status: "expired",
    lastUsedAt: "2025-11-04T07:48:00Z",
    createdAt: "2024-10-20T09:00:00Z",
    usageCount: 412005,
    rateLimit: 300,
    expiresAt: "2026-04-01T00:00:00Z",
  },
];

const meta = {
  title: "CloudUI/DataList/ApiKeysTable",
  component: ApiKeysTable,
  tags: ["autodocs"],
  args: {
    keys: baseKeys,
    onCopyKey: noop,
    onDisableKey: noop,
    onDeleteKey: noop,
    onRegenerateKey: noop,
  },
  decorators: [
    (Story) => (
      <div className="min-h-screen bg-black p-6 text-white">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ApiKeysTable>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const SingleActiveKey: Story = {
  args: {
    keys: [baseKeys[0]],
  },
};

export const ExpiredOnly: Story = {
  args: {
    keys: [baseKeys[2]],
  },
};

export const NoUsageKey: Story = {
  args: {
    keys: [
      {
        ...baseKeys[0],
        id: "key-no-usage",
        name: "Sandbox key",
        description: "Newly provisioned key, not used yet.",
        usageCount: 0,
        lastUsedAt: null,
      },
    ],
  },
};

export const ManyKeys: Story = {
  args: {
    keys: Array.from({ length: 6 }, (_, index) => ({
      ...baseKeys[index % baseKeys.length],
      id: `bulk-${index}`,
      name: `Service key ${index + 1}`,
      keyPrefix: `sk_live_${(1000 + index).toString(16)}`,
      usageCount: 1000 * (index + 1),
    })),
  },
};
