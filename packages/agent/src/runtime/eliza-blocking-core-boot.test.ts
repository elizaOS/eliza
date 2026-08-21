/**
 * Exercises the production blocking-core boot seam with a deterministic runtime harness.
 * The harness records real scheduling-plugin registration and models Personal Assistant
 * service startup at the runtime initialization boundary without external providers.
 */
import { isElizaError, type Plugin } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  initializeBlockingCoreRuntimeForBoot,
  preregisterCorePluginsInDependencyWaves,
} from "./blocking-core-boot.ts";
import type { ResolvedPlugin } from "./plugin-types.ts";

const SCHEDULED_TASK_RUNNER_SERVICE_TYPE = "scheduled-task-runner";
const deterministicScheduledTaskRunnerService = {
  serviceType: SCHEDULED_TASK_RUNNER_SERVICE_TYPE,
};
const schedulingPlugin: Plugin = {
  name: "@elizaos/plugin-scheduling",
  description: "Deterministic scheduling declaration for boot-order tests.",
  dependencies: ["@elizaos/plugin-sql"],
  services: [deterministicScheduledTaskRunnerService as never],
};

function createBootHarness(options: { failScheduling?: boolean } = {}) {
  const events: string[] = [];
  const plugins: Plugin[] = [];
  let runnerRegistered = false;
  const runtime = {
    plugins,
    registerPlugin: async (plugin: Plugin) => {
      events.push(`register:${plugin.name}`);
      if (
        options.failScheduling &&
        plugin.name === "@elizaos/plugin-scheduling"
      ) {
        throw new Error("injected scheduling registration failure");
      }
      plugins.push(plugin);
      runnerRegistered =
        runnerRegistered ||
        Boolean(
          plugin.services?.some(
            (service) =>
              service.serviceType === SCHEDULED_TASK_RUNNER_SERVICE_TYPE,
          ),
        );
    },
  };
  const resolvedPlugins: ResolvedPlugin[] = [
    { name: "@elizaos/plugin-scheduling", plugin: schedulingPlugin },
  ];

  return {
    events,
    runtime,
    resolvedPlugins,
    hasRunner: () => runnerRegistered,
  };
}

describe("blocking core runtime boot", () => {
  for (const blockDeferredPluginImports of [false, true]) {
    it(`registers scheduling exactly once before Personal Assistant startup when blockDeferredPluginImports=${blockDeferredPluginImports}`, async () => {
      const harness = createBootHarness();

      await initializeBlockingCoreRuntimeForBoot({
        blockDeferredPluginImports,
        runtime: harness.runtime as never,
        resolvedPlugins: harness.resolvedPlugins,
        requiredPluginNames: new Set(["@elizaos/plugin-scheduling"]),
        waitForBlockingEnvironment: async () => {
          harness.events.push("blocking-environment");
        },
        initializeCoreRuntime: async () => {
          harness.events.push("personal-assistant:start");
          expect(harness.hasRunner()).toBe(true);
        },
      });

      await preregisterCorePluginsInDependencyWaves({
        runtime: harness.runtime as never,
        resolvedPlugins: harness.resolvedPlugins,
        alreadyPreRegistered: new Set([
          "@elizaos/plugin-sql",
          "@elizaos/plugin-local-inference",
        ]),
        label: "deferred",
      });

      expect(
        harness.events.filter(
          (event) => event === "register:@elizaos/plugin-scheduling",
        ),
      ).toHaveLength(1);
      expect(
        harness.events.indexOf("register:@elizaos/plugin-scheduling"),
      ).toBeLessThan(harness.events.indexOf("personal-assistant:start"));
      expect(harness.events.includes("blocking-environment")).toBe(
        blockDeferredPluginImports,
      );
    });
  }

  it("fails closed before runtime initialization when required scheduling registration fails", async () => {
    const harness = createBootHarness({ failScheduling: true });

    try {
      await initializeBlockingCoreRuntimeForBoot({
        blockDeferredPluginImports: false,
        runtime: harness.runtime as never,
        resolvedPlugins: harness.resolvedPlugins,
        requiredPluginNames: new Set(["@elizaos/plugin-scheduling"]),
        waitForBlockingEnvironment: async () => {},
        initializeCoreRuntime: async () => {
          harness.events.push("personal-assistant:start");
        },
      });
      expect.unreachable("required scheduling registration must fail boot");
    } catch (error) {
      expect(isElizaError(error)).toBe(true);
      if (isElizaError(error)) {
        expect(error.code).toBe("REQUIRED_CORE_PLUGIN_REGISTRATION_FAILED");
        expect(error.severity).toBe("fatal");
        expect(error.context).toMatchObject({
          plugin: "@elizaos/plugin-scheduling",
          phase: "blocking",
        });
      }
    }
    expect(harness.events).not.toContain("personal-assistant:start");
    expect(harness.hasRunner()).toBe(false);
  });
});
