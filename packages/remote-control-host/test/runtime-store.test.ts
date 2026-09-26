import { expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { ChannelType, type Component, type IAgentRuntime } from "@elizaos/core";
import { SecretsService } from "../../../plugins/plugin-assistant/src/features/secrets/services/secrets";
import { createRuntimePlatformSecureStore } from "../src/runtime-store";

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
      getEntityById: async () => ({ id, agentId: id }),
      getRoom: async () => ({
        id,
        agentId: id,
        worldId: id,
        type: ChannelType.SELF,
      }),
      getWorld: async () => ({ id, agentId: id }),
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

it("denies foreign self context before reading, writing, or deleting secrets", async () => {
  const id = randomUUID();
  let calls = 0;
  const runtime = {
    agentId: id,
    getEntityById: async () => ({ agentId: id }),
    getRoom: async () => ({ agentId: id, worldId: id, type: ChannelType.SELF }),
    getWorld: async () => ({ agentId: randomUUID() }),
    getService: () => ({
      get: async () => {
        calls++;
        return "private";
      },
      set: async () => {
        calls++;
        return true;
      },
      delete: async () => {
        calls++;
        return true;
      },
    }),
  } as unknown as IAgentRuntime;
  const store = createRuntimePlatformSecureStore(runtime);
  for (const operation of [
    () => store.get("controller", "runtime.agent_profiles"),
    () => store.set("controller", "runtime.agent_profiles", "value"),
    () => store.delete("controller", "runtime.agent_profiles"),
  ])
    await expect(operation()).rejects.toMatchObject({
      code: "REMOTE_SECRET_CONTEXT_DENIED",
    });
  expect(calls).toBe(0);
});
