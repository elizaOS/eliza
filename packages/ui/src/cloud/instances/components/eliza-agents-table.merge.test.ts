/**
 * mergeAgentList invariant coverage: a background status poll updates/adds but
 * NEVER removes rows on a short/empty response (the regression that blanked the
 * Instances table while the count still read >0). Removal is tombstone-only.
 */

import { describe, expect, it } from "vitest";
import type { SandboxListAgent } from "../lib/use-sandbox-status-poll";
import { type ElizaAgentRow, mergeAgentList } from "./eliza-agents-table";

function row(id: string, status: string): ElizaAgentRow {
  return {
    id,
    agent_name: `agent-${id}`,
    status,
    canonical_web_ui_url: null,
    node_id: null,
    container_name: null,
    bridge_port: null,
    web_ui_port: null,
    headscale_ip: null,
    docker_image: null,
    execution_tier: undefined,
    sandbox_id: null,
    bridge_url: null,
    error_message: null,
    last_heartbeat_at: null,
    created_at: "2026-07-04T00:00:00.000Z",
    updated_at: "2026-07-04T00:00:00.000Z",
  };
}

function apiAgent(id: string, status: string): SandboxListAgent {
  return { id, agentName: `agent-${id}`, status } as SandboxListAgent;
}

const NONE: ReadonlySet<string> = new Set();

describe("mergeAgentList", () => {
  it("keeps every row when the poll returns EMPTY (no blanking on a transient)", () => {
    const prev = [row("a", "running"), row("b", "running")];
    expect(mergeAgentList(prev, [], NONE).map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("keeps rows the poll omitted (partial response) and updates the ones it returned", () => {
    const prev = [row("a", "running"), row("b", "stopped")];
    const merged = mergeAgentList(prev, [apiAgent("a", "stopped")], NONE);
    expect(merged.map((r) => r.id)).toEqual(["a", "b"]);
    expect(merged.find((r) => r.id === "a")?.status).toBe("stopped"); // updated
    expect(merged.find((r) => r.id === "b")?.status).toBe("stopped"); // preserved
  });

  it("appends rows the API introduced", () => {
    const prev = [row("a", "running")];
    const merged = mergeAgentList(
      prev,
      [apiAgent("a", "running"), apiAgent("c", "provisioning")],
      NONE,
    );
    expect(merged.map((r) => r.id)).toEqual(["a", "c"]);
  });

  it("excludes tombstoned ids from both existing rows and additions", () => {
    const prev = [row("a", "running"), row("b", "running")];
    const tombstoned = new Set(["b"]);
    // "b" is being deleted; the eventually-consistent API still returns it.
    const merged = mergeAgentList(
      prev,
      [apiAgent("a", "running"), apiAgent("b", "running")],
      tombstoned,
    );
    expect(merged.map((r) => r.id)).toEqual(["a"]);
  });
});
