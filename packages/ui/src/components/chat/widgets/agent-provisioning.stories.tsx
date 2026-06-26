import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";
import {
  CLOUD_HANDOFF_PHASE_EVENT,
  type CloudHandoffPhase,
} from "../../../events";
import {
  clearPersistedActiveServer,
  createPersistedActiveServer,
  savePersistedActiveServer,
} from "../../../state/persistence";
import {
  assert,
  waitForTestId,
} from "../../../storybook/home-widget-decorator";
import { MockAppProvider } from "../../../storybook/mock-providers";
import { AgentProvisioningWidget } from "./agent-provisioning";

// Home tile for the shared→dedicated cloud-agent handoff (PART B). While a
// freshly-provisioned cloud agent's dedicated container boots the user chats on
// the shared adapter and this tile shows "Setting up…"; a timed-out/failed boot
// shows a Retry; once attached it self-hides.

const SHARED_AGENT_ID = "agent-story-1";

/**
 * Seed a shared-cloud active server (so the widget considers provisioning
 * relevant) and emit a handoff phase BEFORE the widget mounts, mirroring the
 * runtime seam (`useCloudHandoffPhase` subscribes to CLOUD_HANDOFF_PHASE_EVENT).
 */
function SeededProvisioning({
  phase,
  children,
}: {
  phase: CloudHandoffPhase | null;
  children: React.ReactNode;
}) {
  useState(() => {
    savePersistedActiveServer(
      createPersistedActiveServer({
        kind: "cloud",
        id: `cloud:${SHARED_AGENT_ID}`,
        apiBase: `https://www.elizacloud.ai/api/v1/eliza/agents/${SHARED_AGENT_ID}`,
        accessToken: "story-token",
      }),
    );
    if (phase) {
      window.dispatchEvent(
        new CustomEvent(CLOUD_HANDOFF_PHASE_EVENT, {
          detail: { agentId: SHARED_AGENT_ID, phase },
        }),
      );
    }
    return null;
  });
  return <>{children}</>;
}

const meta = {
  title: "Shell/Home Widgets/Agent Provisioning",
  component: AgentProvisioningWidget,
  parameters: { layout: "centered" },
  args: { pluginId: "cloud-agent", slot: "home" },
} satisfies Meta<typeof AgentProvisioningWidget>;

export default meta;
type Story = StoryObj<typeof meta>;

function frame(phase: CloudHandoffPhase | null) {
  return (Story: () => React.JSX.Element) => {
    clearPersistedActiveServer();
    return (
      <MockAppProvider value={{ plugins: [], conversations: [] }}>
        <SeededProvisioning phase={phase}>
          <div className="w-[360px] rounded-2xl bg-accent/20 p-3">
            <Story />
          </div>
        </SeededProvisioning>
      </MockAppProvider>
    );
  };
}

export const Provisioning: Story = {
  decorators: [frame("migrating")],
  play: async ({ canvasElement }) => {
    const card = await waitForTestId(
      canvasElement,
      "chat-widget-agent-provisioning",
    );
    assert(card instanceof HTMLButtonElement, "the whole card is a button");
    assert(
      card.textContent?.includes("Setting up"),
      "shows the provisioning copy",
    );
  },
};

export const ErrorWithRetry: Story = {
  decorators: [frame("failed")],
  play: async ({ canvasElement }) => {
    const card = await waitForTestId(
      canvasElement,
      "chat-widget-agent-provisioning",
    );
    assert(card.textContent?.includes("Setup paused"), "shows the paused copy");
    assert(card.textContent?.includes("Retry"), "offers a retry control");
  },
};
