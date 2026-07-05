/**
 * ElizaAgentsTable per-row view model (#13916): the desktop table and mobile
 * card render one derived row, so the shared derivation owns runtime labels,
 * action availability, and Web UI reachability.
 */

import { describe, expect, it, vi } from "vitest";
import { deriveAgentRow, type ElizaAgentRow } from "./eliza-agents-table";

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
});
