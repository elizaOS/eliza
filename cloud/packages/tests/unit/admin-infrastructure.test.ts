import { describe, expect, test } from "bun:test";
import { classifyContainerHealth } from "../../lib/services/admin-infrastructure";

describe("classifyContainerHealth", () => {
  test("marks runtime-unhealthy containers as failed", () => {
    const result = classifyContainerHealth({
      dbStatus: "running",
      runtime: {
        name: "agent-test",
        id: "abc123",
        image: "agent/agent:cloud-full-ui",
        state: "running",
        status: "Up 3m (unhealthy)",
        runningFor: "3 minutes",
        health: "unhealthy",
      },
      lastHeartbeatAt: new Date().toISOString(),
      errorMessage: null,
    });

    expect(result.status).toBe("failed");
    expect(result.severity).toBe("critical");
    expect(result.reason).toContain("unhealthy");
  });

  test("marks missing runtime containers as missing when control plane expects them", () => {
    const result = classifyContainerHealth({
      dbStatus: "running",
      runtime: null,
      lastHeartbeatAt: new Date().toISOString(),
      errorMessage: null,
    });

    expect(result.status).toBe("missing");
    expect(result.severity).toBe("critical");
  });

  test("treats provisioning records without runtime as warming", () => {
    const result = classifyContainerHealth({
      dbStatus: "provisioning",
      runtime: null,
      lastHeartbeatAt: null,
      errorMessage: null,
    });

    expect(result.status).toBe("warming");
    expect(result.severity).toBe("info");
  });

  test("marks old heartbeats as stale even if runtime is running", () => {
    const result = classifyContainerHealth({
      dbStatus: "running",
      runtime: {
        name: "agent-test",
        id: "abc123",
        image: "agent/agent:cloud-full-ui",
        state: "running",
        status: "Up 2h",
        runningFor: "2 hours",
        health: "healthy",
      },
      lastHeartbeatAt: new Date(Date.now() - 20 * 60_000).toISOString(),
      errorMessage: null,
    });

    expect(result.status).toBe("stale");
    // Severity is downgraded to warning when Docker reports the container as
    // running + healthy (heartbeat mechanism may be broken but container is up)
    expect(result.severity).toBe("warning");
    expect(result.reason).toContain("Heartbeat");
  });

  test("accepts healthy running containers with fresh heartbeat", () => {
    const result = classifyContainerHealth({
      dbStatus: "running",
      runtime: {
        name: "agent-test",
        id: "abc123",
        image: "agent/agent:cloud-full-ui",
        state: "running",
        status: "Up 10m (healthy)",
        runningFor: "10 minutes",
        health: "healthy",
      },
      lastHeartbeatAt: new Date(Date.now() - 2 * 60_000).toISOString(),
      errorMessage: null,
    });

    expect(result.status).toBe("healthy");
    expect(result.severity).toBe("info");
  });
});
