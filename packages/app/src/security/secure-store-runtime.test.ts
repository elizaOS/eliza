// @vitest-environment node
import { randomUUID } from "node:crypto";
import type { Component, IAgentRuntime } from "@elizaos/core";
import { expect, it } from "vitest";
import { SecretsService } from "../../../../plugins/plugin-assistant/src/features/secrets/services/secrets";
import { createRuntimePlatformSecureStore } from "./secure-store-runtime";

it("persists encrypted controller credentials in components and isolates agents", async () => {
  const components = new Map<string, Component>();
  const agentId = randomUUID();
  function host(id: string) {
    let secrets: SecretsService;
    const runtime = {
      agentId: id,
      character: { name: "Test", settings: {} },
      getSetting: (key: string) =>
        key === "ENCRYPTION_SALT"
          ? "high-entropy-test-secret-material-abcdef0123456789"
          : undefined,
      getComponents: async () => [...components.values()],
      createComponent: async (component: Component) => {
        components.set(component.id, component);
        return true;
      },
      updateComponent: async (component: Component) => {
        components.set(component.id, component);
      },
      deleteComponent: async (id: string) => {
        components.delete(id);
      },
      getService: () => secrets,
    } as unknown as IAgentRuntime;
    secrets = new SecretsService(runtime);
    return createRuntimePlatformSecureStore(runtime);
  }
  const first = host(agentId);
  const credential = JSON.stringify({
    privateKey: "secret-private-controller-key",
    hostToken: "secret-private-owner-token",
  });
  expect(
    await first.set("controller", "runtime.agent_profiles", credential),
  ).toEqual({ ok: true });
  expect(JSON.stringify([...components.values()])).not.toContain(
    "secret-private",
  );
  expect(JSON.stringify([...components.values()])).toContain(
    '"encrypted":true',
  );
  expect(
    await host(agentId).get("controller", "runtime.agent_profiles"),
  ).toEqual({ ok: true, value: credential });
  expect(
    await host(randomUUID()).get("controller", "runtime.agent_profiles"),
  ).toEqual({ ok: false, reason: "not_found" });
  expect(await first.delete("controller", "runtime.agent_profiles")).toEqual({
    ok: true,
    deleted: true,
  });
});
