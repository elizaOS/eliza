/**
 * Basic capabilities must provide the connector target-source registry so
 * connector plugins (e.g. Discord) can register target enumerators and the
 * host's connector-target-catalog can list them. Real AgentRuntime, real
 * service lifecycle; no mocks.
 */
import {
  AgentRuntime,
  CONNECTOR_TARGET_SOURCE_REGISTRY_SERVICE,
  type TargetSource,
  type TargetSourceRegistry,
} from "@elizaos/core";
import { initializeTestRuntime } from "@elizaos/testing/runtime";
import { describe, expect, it } from "vitest";
import { basicServices } from "./index.ts";

describe("basic capabilities connector target-source registry", () => {
  it("declares the target-source registry service", () => {
    expect(basicServices.map((service) => service.serviceType)).toContain(
      CONNECTOR_TARGET_SOURCE_REGISTRY_SERVICE,
    );
  });

  it("starts the registry on a runtime so connector sources are listed", async () => {
    const runtime = new AgentRuntime({
      character: { name: "Target sources", bio: "Registry wiring" },
      plugins: [
        {
          name: "basic-target-sources",
          services: basicServices.filter(
            (service) =>
              service.serviceType === CONNECTOR_TARGET_SOURCE_REGISTRY_SERVICE,
          ),
        },
      ],
      logLevel: "fatal",
    });
    Object.assign(runtime, { serverless: true });
    try {
      await initializeTestRuntime(runtime, { skipMigrations: true });
      await runtime.getServiceLoadPromise(
        CONNECTOR_TARGET_SOURCE_REGISTRY_SERVICE,
      );
      const registry = runtime.getService(
        CONNECTOR_TARGET_SOURCE_REGISTRY_SERVICE,
      ) as unknown as TargetSourceRegistry | null;
      if (!registry) {
        throw new Error("Connector target-source registry did not start");
      }
      const source: TargetSource = {
        platform: "discord",
        enumerate: async () => [
          {
            platform: "discord",
            groupId: "guild-1",
            groupName: "Guild",
            targets: [{ id: "chan-1", name: "general", kind: "channel" }],
          },
        ],
      };
      registry.register(source);
      expect(registry.list()).toEqual([source]);
      expect(await registry.list()[0]?.enumerate({})).toHaveLength(1);
    } finally {
      await runtime.stop();
    }
  });
});
