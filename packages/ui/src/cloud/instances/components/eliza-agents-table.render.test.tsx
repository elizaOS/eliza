// @vitest-environment jsdom

/**
 * ElizaAgentsTable per-row view model (#13916): the desktop table and mobile
 * card render one derived row, so the shared derivation owns runtime labels,
 * action availability, and Web UI reachability. Also covers the deactivate
 * (sleep) / reactivate (wake) affordances (#15603): availability derivation,
 * the sleeping row rendering as a designed non-error state with a Reactivate
 * action, and the deactivate confirm dialog's billing-transparency copy.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  deriveAgentRow,
  type ElizaAgentRow,
  ElizaAgentsTable,
} from "./eliza-agents-table";

vi.mock("../lib/i18n", () => ({
  useT: () => (_key: string, options?: { defaultValue?: string }) =>
    options?.defaultValue ?? _key,
}));

function row(overrides: Partial<ElizaAgentRow>): ElizaAgentRow {
  return {
    id: "00000000-1111-2222-3333-444444444444",
    agent_name: "Ada",
    status: "running",
    canonical_web_ui_url: "https://agent.example",
    node_id: null,
    container_name: null,
    bridge_port: null,
    web_ui_port: null,
    headscale_ip: null,
    docker_image: null,
    execution_tier: "dedicated-lazy",
    sandbox_id: "sb-1",
    bridge_url: null,
    error_message: null,
    last_heartbeat_at: null,
    created_at: "2026-07-04T00:00:00.000Z",
    updated_at: "2026-07-04T00:00:00.000Z",
    ...overrides,
  };
}

function derive(
  overrides: Partial<ElizaAgentRow>,
  {
    active = false,
    actionInProgress = null,
  }: { active?: boolean; actionInProgress?: string | null } = {},
) {
  const sb = row(overrides);
  return deriveAgentRow(
    sb,
    {
      getStatus: () =>
        active
          ? {
              jobId: "job-12345678",
              key: sb.id,
              status: "pending" as const,
              error: null,
              startedAt: 0,
            }
          : undefined,
      isActive: vi.fn(() => active),
    },
    actionInProgress,
  );
}

describe("ElizaAgentsTable per-row view model", () => {
  afterEach(() => {
    cleanup();
  });

  it("marks a running cloud sandbox as stoppable with standalone Web UI access", () => {
    const vm = derive({ status: "running" });

    expect(vm.displayStatus).toBe("running");
    expect(vm.runtimeKind).toBe("sandbox");
    expect(vm.isDocker).toBe(false);
    expect(vm.hasStandaloneWebUi).toBe(true);
    expect(vm.canStart).toBe(false);
    expect(vm.canStop).toBe(true);
  });

  it("resolves docker-backed, shared, sandbox, and unprovisioned runtime kinds", () => {
    expect(
      derive({ node_id: "node-7", docker_image: "eliza:1" }).runtimeKind,
    ).toBe("managed");
    expect(derive({ execution_tier: "shared" }).runtimeKind).toBe("shared");
    expect(
      derive({ status: "provisioning", sandbox_id: null }).runtimeKind,
    ).toBe("sandbox");
    expect(
      derive({
        status: "pending",
        sandbox_id: null,
        canonical_web_ui_url: null,
      }).runtimeKind,
    ).toBe("notProvisioned");
    // Deactivation releases the container (sandbox_id cleared) but the agent
    // remains an established sandbox — never "Not provisioned".
    expect(derive({ status: "sleeping", sandbox_id: null }).runtimeKind).toBe(
      "sandbox",
    );
  });

  it("hides standalone Web UI for shared rows even when the API returns a URL", () => {
    const vm = derive({
      status: "running",
      execution_tier: "shared",
      canonical_web_ui_url: "https://agent.example",
    });

    expect(vm.hasStandaloneWebUi).toBe(false);
  });

  it("uses active poll jobs as the displayed status and busy state", () => {
    const vm = derive({ status: "pending" }, { active: true });

    expect(vm.displayStatus).toBe("provisioning");
    expect(vm.isProvisioningActive).toBe(true);
    expect(vm.busy).toBe(true);
    expect(vm.trackedJob?.jobId).toBe("job-12345678");
    expect(vm.canStart).toBe(false);
    expect(vm.canStop).toBe(false);
  });

  it("blocks row actions while a row-level action is in progress", () => {
    const vm = derive(
      { status: "stopped" },
      { actionInProgress: "00000000-1111-2222-3333-444444444444" },
    );

    expect(vm.busy).toBe(true);
    expect(vm.canStart).toBe(false);
    expect(vm.canStop).toBe(false);
  });

  it("offers Deactivate only for running dedicated rows and Reactivate only for sleeping rows", () => {
    const runningDedicated = derive({ status: "running" });
    expect(runningDedicated.canSleep).toBe(true);
    expect(runningDedicated.canWake).toBe(false);

    // Shared-runtime agents have no dedicated compute to free.
    const runningShared = derive({
      status: "running",
      execution_tier: "shared",
    });
    expect(runningShared.canSleep).toBe(false);

    const sleeping = derive({ status: "sleeping" });
    expect(sleeping.canWake).toBe(true);
    expect(sleeping.canSleep).toBe(false);
    // A deactivated agent is a settled, designed state — not a resumable
    // stop and not startable through the provision path.
    expect(sleeping.canStart).toBe(false);
    expect(sleeping.canStop).toBe(false);

    // Both affordances yield to in-flight work.
    const busySleeping = derive({ status: "sleeping" }, { active: true });
    expect(busySleeping.canWake).toBe(false);
    const busyRunning = derive(
      { status: "running" },
      { actionInProgress: "00000000-1111-2222-3333-444444444444" },
    );
    expect(busyRunning.canSleep).toBe(false);
  });

  it("renders sleeping and idle rates without conflating deactivated and idle billing", () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });

    render(
      <QueryClientProvider client={queryClient}>
        <ElizaAgentsTable
          sandboxes={[
            row({ status: "sleeping", canonical_web_ui_url: null }),
            row({
              id: "00000000-1111-2222-3333-555555555555",
              status: "stopped",
            }),
          ]}
        />
      </QueryClientProvider>,
    );

    // The raw lifecycle state is shown (muted styling), never an error render.
    expect(screen.getAllByText("sleeping").length).toBeGreaterThanOrEqual(1);
    // Reactivate replaces the resume/suspend affordances for this state.
    expect(
      screen.getAllByRole("button", { name: "Reactivate agent" }).length,
    ).toBeGreaterThanOrEqual(1);
    expect(
      screen.queryByRole("button", { name: "Deactivate agent" }),
    ).toBeNull();
    // Billing transparency on the card itself: an explicit $0.00/hr.
    expect(screen.getAllByText("$0.00/hr").length).toBeGreaterThanOrEqual(1);
    // Idle agents still bill at a low hourly rate, so they must not visually
    // collapse to the deactivated zero-cost badge.
    expect(screen.getAllByText("<$0.01/hr").length).toBeGreaterThanOrEqual(1);
  });

  it("requires a billing-transparency confirm before deactivating", async () => {
    const user = userEvent.setup();
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });

    render(
      <QueryClientProvider client={queryClient}>
        <ElizaAgentsTable sandboxes={[row({ status: "running" })]} />
      </QueryClientProvider>,
    );

    const [deactivate] = screen.getAllByRole("button", {
      name: "Deactivate agent",
    });
    await user.click(deactivate);

    const dialog = await screen.findByRole("alertdialog");
    expect(
      within(dialog).getByText(/stops consuming hourly credits/),
    ).toBeTruthy();
    expect(
      within(dialog).getByText(/if the backup cannot be saved/i),
    ).toBeTruthy();
    expect(
      within(dialog).getByText(/requires available credits/i),
    ).toBeTruthy();

    // Cancel is a real exit: no job fired, dialog gone.
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("keeps the empty Agents page connected to the Eliza app create flow", () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });

    render(
      <QueryClientProvider client={queryClient}>
        <ElizaAgentsTable sandboxes={[]} />
      </QueryClientProvider>,
    );

    const links = screen.getAllByRole("link", { name: "Open Eliza app" });
    expect(links.length).toBeGreaterThanOrEqual(1);
    for (const link of links) {
      expect(link.getAttribute("href")).toBe("https://app.elizacloud.ai");
      expect(link.getAttribute("target")).toBe("_blank");
      expect(link.getAttribute("rel")).toBe("noreferrer");
    }
  });
});
