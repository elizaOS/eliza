/**
 * Storybook stories for the ApiKeysTable.
 */
import type { Meta, StoryObj } from "@storybook/react";
import { type ApiKeyDisplay, ApiKeysTable } from "./api-keys-table";

const noop = () => {};

const baseKeys: ApiKeyDisplay[] = [
  {
    id: "key-1",
    name: "Production API",
    keyPrefix: "sk_live_8f2a",
    status: "active",
    createdAt: "2026-01-12T09:00:00Z",
    lastUsedAt: "2026-06-04T10:24:00Z",
  },
  {
    id: "key-2",
    name: "Staging API",
    keyPrefix: "sk_test_3b91",
    status: "inactive",
    createdAt: "2026-02-02T12:30:00Z",
    lastUsedAt: "2026-05-20T18:10:00Z",
  },
  {
    id: "key-3",
    name: "Legacy mobile",
    keyPrefix: "sk_live_a013",
    status: "expired",
    createdAt: "2024-10-20T09:00:00Z",
    lastUsedAt: "2025-11-04T07:48:00Z",
  },
];

const meta = {
  title: "CloudUI/DataList/ApiKeysTable",
  component: ApiKeysTable,
  tags: ["autodocs"],
  args: {
    keys: baseKeys,
    onRevokeKey: noop,
  },
  decorators: [
    (Story) => (
      <div className="min-h-screen bg-bg p-6 text-txt">
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

export const NeverUsedKey: Story = {
  args: {
    keys: [
      {
        ...baseKeys[0],
        id: "key-never-used",
        name: "Sandbox key",
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
    })),
  },
};
