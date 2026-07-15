/**
 * Storybook stories for AccountCommandTable — the desktop command-center
 * table across a mixed-health pool, with and without #16355 lease
 * observability (proving the feature-detected column).
 */

import type { Meta, StoryObj } from "@storybook/react";
import type { AccountWithCredentialFlag } from "../../api/client-agent";
import { MockAppProvider } from "../../storybook/mock-providers";
import { AccountCommandTable } from "./AccountCommandTable";

const now = Date.now();

function makeAccount(
  overrides: Partial<AccountWithCredentialFlag>,
): AccountWithCredentialFlag {
  return {
    id: "acc",
    providerId: "anthropic-subscription",
    label: "Account",
    source: "oauth",
    enabled: true,
    priority: 1,
    createdAt: now - 1000 * 60 * 60 * 24 * 30,
    health: "ok",
    hasCredential: true,
    ...overrides,
  };
}

const pool: AccountWithCredentialFlag[] = [
  makeAccount({
    id: "primary",
    label: "Anthropic — primary",
    email: "primary@team.io",
    priority: 1,
    lastUsedAt: now - 1000 * 60 * 3,
    usage: {
      sessionPct: 34,
      weeklyPct: 22,
      resetsAt: now + 1000 * 60 * 60 * 3,
      refreshedAt: now,
    },
  }),
  makeAccount({
    id: "heavy",
    label: "Anthropic — heavy",
    email: "heavy@team.io",
    priority: 2,
    lastUsedAt: now - 1000 * 60 * 40,
    usage: {
      sessionPct: 88,
      weeklyPct: 71,
      resetsAt: now + 1000 * 60 * 55,
      refreshedAt: now,
    },
  }),
  makeAccount({
    id: "capped",
    label: "Anthropic — capped",
    email: "capped@team.io",
    priority: 3,
    health: "rate-limited",
    healthDetail: { until: now + 1000 * 60 * 90 },
    lastUsedAt: now - 1000 * 60 * 90,
    usage: {
      sessionPct: 99,
      weeklyPct: 84,
      resetsAt: now + 1000 * 60 * 90,
      refreshedAt: now,
    },
  }),
  makeAccount({
    id: "stale",
    label: "Anthropic — needs reauth",
    email: "stale@team.io",
    priority: 4,
    health: "needs-reauth",
    healthDetail: { lastError: "refresh_token expired" },
    lastUsedAt: now - 1000 * 60 * 60 * 26,
  }),
  makeAccount({
    id: "backup",
    label: "Anthropic — backup",
    email: "backup@team.io",
    source: "api-key",
    enabled: false,
    priority: 5,
    health: "invalid",
    healthDetail: { lastError: "401 Unauthorized" },
  }),
];

const observablePool: AccountWithCredentialFlag[] = pool.map((account, i) => ({
  ...account,
  observability: {
    activeLeaseCount: i === 0 ? 2 : i === 1 ? 1 : 0,
    lastLeaseAt: account.lastUsedAt ?? null,
    lastSelectedAt: account.lastUsedAt ?? null,
    servedLastRequest: i === 0,
  },
}));

const meta = {
  title: "Accounts/AccountCommandTable",
  component: AccountCommandTable,
  tags: ["autodocs"],
  decorators: [
    (Story) => (
      <MockAppProvider>
        <div className="max-w-5xl p-6">
          <Story />
        </div>
      </MockAppProvider>
    ),
  ],
  args: {
    providerId: "anthropic-subscription",
    accounts: pool,
    activeAccountId: "primary",
    saving: new Set<string>(),
    onPatch: async () => {},
    onReauthenticate: () => {},
    onDelete: async () => {},
    onTest: async () => {},
    onRefreshUsage: async () => {},
    onMove: async () => {},
  },
} satisfies Meta<typeof AccountCommandTable>;

export default meta;
type Story = StoryObj<typeof meta>;

/** No observability payload → lease column is hidden (pre-#16355 host). */
export const WithoutObservability: Story = {};

/** #16355 present → lease column with active counts + served-last marker. */
export const WithObservability: Story = {
  args: {
    accounts: observablePool,
  },
};

export const EmptyPool: Story = {
  args: {
    accounts: [],
  },
};
