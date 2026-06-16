import { describe, expect, it, vi } from "vitest";
import * as dockerPortAllocation from "../docker-port-allocation";

describe("docker-port-allocation", () => {
  it("defines the app container host port range", () => {
    expect(dockerPortAllocation.APP_CONTAINER_HOST_PORT_MIN).toBe(20000);
    expect(dockerPortAllocation.APP_CONTAINER_HOST_PORT_MAX).toBe(40000);
  });

  it("allocateAppContainerHostPort skips ports already used on the node", async () => {
    vi.spyOn(dockerPortAllocation, "getUsedDockerHostPorts").mockResolvedValue(
      new Set([20000, 20001, 20002]),
    );

    const port = await dockerPortAllocation.allocateAppContainerHostPort("node-a");
    expect(port).toBeGreaterThanOrEqual(dockerPortAllocation.APP_CONTAINER_HOST_PORT_MIN);
    expect(port).toBeLessThan(dockerPortAllocation.APP_CONTAINER_HOST_PORT_MAX);
    expect([20000, 20001, 20002]).not.toContain(port);
  });
});
