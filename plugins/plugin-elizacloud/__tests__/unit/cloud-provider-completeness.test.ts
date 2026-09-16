/** Verifies Cloud model-context providers render every tracked container without recency windows. */
import type { IAgentRuntime, Memory, State } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { cloudStatusProvider } from "../../src/cloud-providers/cloud-status";
import { containerHealthProvider } from "../../src/cloud-providers/container-health";

const containers = Array.from({ length: 12 }, (_, index) => ({
  id: `container-${index}`,
  name: `container name ${index}`,
  status: "running",
  billing_status: "active",
  load_balancer_url: `https://container-${index}.example.com`,
}));

function runtime(): IAgentRuntime {
  const services: Record<string, unknown> = {
    CLOUD_AUTH: {
      isAuthenticated: () => true,
      isApiKeyInvalid: () => false,
    },
    CLOUD_CONTAINER: {
      getTrackedContainers: () => containers,
    },
    CLOUD_BRIDGE: {
      getConnectedContainerIds: () => containers.map((container) => container.id),
    },
  };
  return {
    getService: (type: string) => services[type],
  } as unknown as IAgentRuntime;
}

const message = {} as Memory;
const state = {} as State;

describe("Cloud provider completeness", () => {
  it("includes every tracked container in status context", async () => {
    const result = await cloudStatusProvider.get(runtime(), message, state);
    expect(result.text).toContain("container name 11");
    expect((result.data?.containers as unknown[] | undefined)?.length).toBe(12);
    expect(result.data).not.toHaveProperty("truncated");
  });

  it("includes every running container in health context", async () => {
    const result = await containerHealthProvider.get(runtime(), message, state);
    expect(result.text).toContain("container name 11");
    expect((result.data?.reports as unknown[] | undefined)?.length).toBe(12);
    expect(result.data).not.toHaveProperty("truncated");
  });
});
