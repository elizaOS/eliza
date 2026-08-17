/**
 * Storybook states for the read-only Account Limits card, including partial
 * source failure, stale refresh, retry, and narrow-screen content pressure.
 */

import type { AccountLimitsSnapshot } from "@elizaos/cloud-shared/lib/services/account-limits-snapshot";
import type { Meta, StoryObj } from "@storybook/react";
import { CloudI18nProvider } from "../../shell/CloudI18nProvider";
import { AccountLimitsCardView } from "./account-limits-card";

const READY_SNAPSHOT: AccountLimitsSnapshot = {
  observedAt: "2026-08-16T00:00:00.000Z",
  cloudCharacters: {
    source: "cloud-character-quota",
    state: "available",
    used: 2,
    limit: 5,
  },
  agentSandboxes: {
    source: "agent-sandbox-quota",
    used: 3,
    nonEagerCreate: { state: "available", limit: 5 },
    eagerManagedCreate: { state: "available", limit: 100 },
    state: "available",
    nonEagerCreateLimit: 5,
    eagerManagedCreateLimit: 100,
  },
  containers: {
    source: "container-quota",
    state: "available",
    used: 1,
    limit: 5,
  },
  apps: {
    source: "apps-service",
    state: "available",
    used: 4,
    limit: 25,
  },
  storage: {
    source: "org-storage-quota",
    state: "available",
    bytesUsed: "1073741824",
    bytesLimit: "5368709120",
  },
  inferenceRateLimits: {
    source: "org-rate-limits",
    state: "available",
    completionsRpm: 120,
    embeddingsRpm: 200,
  },
};

function snapshot(): AccountLimitsSnapshot {
  return structuredClone(READY_SNAPSHOT);
}

const meta = {
  title: "Cloud/Billing/AccountLimitsCard",
  component: AccountLimitsCardView,
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
} satisfies Meta<typeof AccountLimitsCardView>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Loading: Story = {
  args: { state: { kind: "loading" } },
};

export const ReadyBelowLimits: Story = {
  args: {
    state: {
      kind: "ready",
      snapshot: snapshot(),
      refreshing: false,
      refreshFailed: false,
    },
  },
};

export const AtAndOverLimits: Story = {
  args: {
    state: {
      kind: "ready",
      snapshot: (() => {
        const value = snapshot();
        value.cloudCharacters = {
          ...value.cloudCharacters,
          state: "at-limit",
          used: 5,
        };
        value.containers = {
          ...value.containers,
          state: "over-limit",
          used: 6,
        };
        value.storage = {
          ...value.storage,
          state: "over-limit",
          bytesUsed: "6442450944",
        };
        return value;
      })(),
      refreshing: false,
      refreshFailed: false,
    },
  },
};

export const PartialUnavailable: Story = {
  args: {
    state: {
      kind: "ready",
      snapshot: (() => {
        const value = snapshot();
        value.storage = {
          source: "org-storage-quota",
          state: "unavailable",
          reason: "source read failed",
        };
        value.inferenceRateLimits = {
          source: "org-rate-limits",
          state: "unavailable",
          reason: "source read failed",
        };
        return value;
      })(),
      refreshing: false,
      refreshFailed: false,
    },
  },
};

export const SandboxPathPartiallyUnavailable: Story = {
  args: {
    state: {
      kind: "ready",
      snapshot: (() => {
        const value = snapshot();
        value.agentSandboxes.eagerManagedCreate = {
          state: "unavailable",
          reason: "source read failed",
        };
        value.agentSandboxes.state = "unavailable";
        return value;
      })(),
      refreshing: false,
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

export const WaitingForConnection: Story = {
  args: { state: { kind: "paused" } },
};

export const RefreshingExistingSnapshot: Story = {
  args: {
    state: {
      kind: "ready",
      snapshot: snapshot(),
      refreshing: true,
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
      refreshFailed: true,
    },
  },
};

export const RefreshPausedWithSnapshot: Story = {
  args: {
    state: {
      kind: "ready",
      snapshot: snapshot(),
      refreshing: false,
      refreshPaused: true,
      refreshFailed: false,
    },
  },
};

export const LongSourceAt320: Story = {
  args: {
    state: {
      kind: "ready",
      snapshot: (() => {
        const value = snapshot();
        value.apps.source =
          "future-account-limit-authority-with-a-long-source-name";
        return value;
      })(),
      refreshing: false,
      refreshFailed: false,
    },
  },
  parameters: {
    viewport: { defaultViewport: "mobile1" },
  },
};
