import { describe, expect, test } from "bun:test";
import type { AgentSandboxStatus } from "@/db/schemas/agent-sandboxes";
import type { DockerNodeStatus } from "@/db/schemas/docker-nodes";

describe("Status Consistency", () => {
  const ALL_SANDBOX: AgentSandboxStatus[] = [
    "pending",
    "provisioning",
    "running",
    "stopped",
    "disconnected",
    "error",
  ];
  const ALL_NODE: DockerNodeStatus[] = ["healthy", "degraded", "offline", "unknown"];
  const BADGE = new Set(["running", "stopped", "error", "provisioning", "pending", "disconnected"]);
  test("badge covers all sandbox statuses", () => {
    for (const s of ALL_SANDBOX) expect(BADGE.has(s)).toBe(true);
  });
  test("badge covers all node statuses", () => {
    for (const s of ALL_NODE) expect(new Set(ALL_NODE).has(s)).toBe(true);
  });
});
