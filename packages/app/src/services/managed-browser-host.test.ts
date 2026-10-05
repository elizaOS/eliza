// @vitest-environment node
import type { IAgentRuntime } from "@elizaos/core";
import { expect, it, vi } from "vitest";
import {
  initializeManagedBrowserHost,
  managedBrowserPlugins,
} from "../../../cloud/services/agent-server/src/browser-host";

it("actual managed composition registers browser/search/assistant and encrypted secrets", async () => {
  const plugins = managedBrowserPlugins(true);
  expect(plugins.some((plugin) => plugin.name === "assistant")).toBe(true);
  expect(
    plugins.some((plugin) =>
      plugin.services?.some((service) => service.serviceType === "browser"),
    ),
  ).toBe(true);
  expect(
    plugins.some((plugin) =>
      plugin.services?.some((service) => service.serviceType === "SECRETS"),
    ),
  ).toBe(true);
  expect(plugins.some((plugin) => plugin.name === "webSearch")).toBe(true);
  const getCache = vi.fn(async () => undefined);
  const runtime = { agentId: "agent", getCache } as unknown as IAgentRuntime;
  await initializeManagedBrowserHost(runtime);
  expect(getCache).toHaveBeenCalledWith(
    "remote-browser-controller:configured:v1",
  );
  expect(
    managedBrowserPlugins(false).some((plugin) =>
      plugin.services?.some((service) => service.serviceType === "SECRETS"),
    ),
  ).toBe(false);
});

it("managed HTTP route rejects message-sender authority without verified agent ownership", async () => {
  const { createRoutes } = await import(
    "../../../cloud/services/agent-server/src/routes"
  );
  const useRuntime = vi.fn();
  const manager = {
    useRuntime,
  } as unknown as import("../../../cloud/services/agent-server/src/agent-manager").AgentManager;
  const app = createRoutes(manager, "internal-secret").compile();
  const response = await app.handle(
    new Request("http://localhost/agents/agent/remote-browser/status", {
      headers: {
        "x-server-token": "internal-secret",
        "x-eliza-user-id": "message-sender",
      },
    }),
  );
  expect(response.status).toBe(403);
  expect(useRuntime).not.toHaveBeenCalled();
});
