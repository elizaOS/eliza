/** Storybook states for the canonical read-only active compute snapshot. */

import type { Meta, StoryObj } from "@storybook/react";
import { CloudI18nProvider } from "../../shell/CloudI18nProvider";
import type {
  BillingSnapshotResource,
  BillingSnapshotV2View,
} from "../data/billing-snapshot";
import { ActiveComputeCardView } from "./active-compute-card";

const OBSERVED_AT = "2026-08-21T10:20:30.000Z";

function available<T>(value: T, source = "billing-story") {
  return {
    status: "available" as const,
    source,
    observedAt: OBSERVED_AT,
    value,
  };
}

function unavailable(retryable: boolean) {
  return {
    status: "unavailable" as const,
    source: "billing-story",
    observedAt: OBSERVED_AT,
    error: { code: "source_unavailable", retryable },
  };
}

function exact<Unit extends "usd" | "usd_per_hour" | "usd_per_day">(
  value: string,
  unit: Unit,
) {
  return { value, unit, currency: "USD" as const };
}

const CONTAINER: BillingSnapshotResource = {
  resourceType: "container",
  resourceId: "container-story-api",
  name: "Production API",
  status: "running",
  billingStatus: "active",
  billingInterval: "day",
  lastBilledAt: "2026-08-21T09:00:00.000Z",
  nextBillingAt: "2026-08-22T09:00:00.000Z",
  estimatedNextBillingAt: "2026-08-22T09:00:00.000Z",
  ratePerHour: available(exact("0.125000", "usd_per_hour")),
  estimatedRecurringComputeCostPerDay: available(
    exact("3.000000", "usd_per_day"),
  ),
};

const SANDBOX: BillingSnapshotResource = {
  resourceType: "agent_sandbox",
  resourceId: "sandbox-story-research",
  name: "Research agent",
  status: "running",
  billingStatus: "active",
  billingInterval: "hour",
  lastBilledAt: null,
  nextBillingAt: null,
  estimatedNextBillingAt: "2026-08-21T11:00:00.000Z",
  ratePerHour: available(exact("0.050000", "usd_per_hour")),
  estimatedRecurringComputeCostPerDay: available(
    exact("1.200000", "usd_per_day"),
  ),
};

function snapshot(
  overrides: Partial<BillingSnapshotV2View> = {},
): BillingSnapshotV2View {
  return {
    snapshotStartedAt: OBSERVED_AT,
    snapshotCompletedAt: OBSERVED_AT,
    balance: available({
      balance: exact("125.500000", "usd"),
      revision: "42",
    }),
    activeCompute: {
      resources: available([CONTAINER, SANDBOX]),
      estimatedRecurringComputeCostPerDay: available(
        exact("4.200000", "usd_per_day"),
      ),
    },
    ...overrides,
  };
}

const meta = {
  title: "Cloud/Billing/ActiveComputeCard",
  component: ActiveComputeCardView,
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <CloudI18nProvider initialLang="en">
        <div className="mx-auto w-full max-w-5xl bg-bg p-2 sm:p-6">
          <Story />
        </div>
      </CloudI18nProvider>
    ),
  ],
  args: { onRetry: () => undefined },
} satisfies Meta<typeof ActiveComputeCardView>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Loading: Story = { args: { state: { kind: "loading" } } };

export const AvailableTwoResources: Story = {
  args: {
    state: {
      kind: "ready",
      snapshot: snapshot(),
      refreshing: false,
      refreshPaused: false,
      refreshFailed: false,
    },
  },
};

export const Empty: Story = {
  args: {
    state: {
      kind: "ready",
      snapshot: snapshot({
        activeCompute: {
          resources: available([]),
          estimatedRecurringComputeCostPerDay: available(
            exact("0.000000", "usd_per_day"),
          ),
        },
      }),
      refreshing: false,
      refreshPaused: false,
      refreshFailed: false,
    },
  },
};

export const PartialRateUnavailable: Story = {
  args: {
    state: {
      kind: "ready",
      snapshot: snapshot({
        activeCompute: {
          resources: available([
            CONTAINER,
            { ...SANDBOX, ratePerHour: unavailable(true) },
          ]),
          estimatedRecurringComputeCostPerDay: unavailable(false),
        },
      }),
      refreshing: false,
      refreshPaused: false,
      refreshFailed: false,
    },
  },
};

export const WholeRequestError: Story = {
  args: { state: { kind: "error", retrying: false } },
};

export const Retrying: Story = {
  args: { state: { kind: "error", retrying: true } },
};

export const Refreshing: Story = {
  args: {
    state: {
      kind: "ready",
      snapshot: snapshot(),
      refreshing: true,
      refreshPaused: false,
      refreshFailed: false,
    },
  },
};

export const StaleRefreshFailure: Story = {
  args: {
    state: {
      kind: "ready",
      snapshot: snapshot(),
      refreshing: false,
      refreshPaused: false,
      refreshFailed: true,
    },
  },
};

export const UnknownPolicy: Story = {
  args: {
    state: {
      kind: "ready",
      snapshot: snapshot({
        activeCompute: {
          resources: {
            status: "unknown_policy",
            source: "billing-story",
            observedAt: OBSERVED_AT,
            blockedBy: ["#23091"],
          },
          estimatedRecurringComputeCostPerDay: {
            status: "unknown_policy",
            source: "billing-story",
            observedAt: OBSERVED_AT,
            blockedBy: ["#23091"],
          },
        },
      }),
      refreshing: false,
      refreshPaused: false,
      refreshFailed: false,
    },
  },
};

export const LongExactAt320: Story = {
  args: {
    state: {
      kind: "ready",
      snapshot: snapshot({
        activeCompute: {
          resources: available([
            {
              ...CONTAINER,
              resourceId:
                "container-with-a-long-identifier-that-must-wrap-at-320px",
              name: "Long-running production analytics container",
              ratePerHour: available(
                exact("900719925474099312345678.123456", "usd_per_hour"),
              ),
            },
          ]),
          estimatedRecurringComputeCostPerDay: available(
            exact("900719925474099312345678.123456", "usd_per_day"),
          ),
        },
      }),
      refreshing: false,
      refreshPaused: false,
      refreshFailed: false,
    },
  },
  parameters: { viewport: { defaultViewport: "mobile1" } },
};
