/** Proves Agent Skills command registration through the real runtime service lifecycle. */

import {
  AgentRuntime,
  type IAgentRuntime,
  type Plugin,
  Service,
  type ServiceClass,
} from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { AgentSkillsPluginLifecycleService } from "../../../../plugins/plugin-agent-skills/src/init.ts";
import type { AgentSkillsService } from "../../../../plugins/plugin-agent-skills/src/services/skills.ts";

class FixtureSkillsService extends Service {
  static serviceType = "AGENT_SKILLS_SERVICE";
  capabilityDescription =
    "Provides one loaded skill for lifecycle verification";

  static async start(runtime: IAgentRuntime): Promise<FixtureSkillsService> {
    return new FixtureSkillsService(runtime);
  }

  getLoadedSkills(): ReturnType<AgentSkillsService["getLoadedSkills"]> {
    return [
      {
        slug: "calendar",
        description: "Manage calendar events",
      },
    ] as ReturnType<AgentSkillsService["getLoadedSkills"]>;
  }

  getCatalogStats(): ReturnType<AgentSkillsService["getCatalogStats"]> {
    return {
      loaded: 1,
      installed: 1,
      total: 1,
      cachedAt: null,
      storageType: "memory",
      categories: ["productivity"],
    };
  }

  async stop(): Promise<void> {}
}

describe("Agent Skills runtime lifecycle", () => {
  it("waits for a delayed commands service before publishing skill commands", async () => {
    const commandsStart = Promise.withResolvers<void>();
    const registeredKeys: string[] = [];

    class DelayedCommandsService extends Service {
      static serviceType = "commands";
      capabilityDescription = "Captures skill command registration";

      static async start(
        runtime: IAgentRuntime,
      ): Promise<DelayedCommandsService> {
        await commandsStart.promise;
        return new DelayedCommandsService(runtime);
      }

      register(command: { key: string }): void {
        registeredKeys.push(command.key);
      }

      async stop(): Promise<void> {}
    }

    const commandsPlugin: Plugin = {
      name: "fixture-commands",
      description: "Delays the commands service until the test releases it",
      services: [DelayedCommandsService as ServiceClass],
    };
    const skillsPlugin: Plugin = {
      name: "fixture-agent-skills",
      description: "Uses the production Agent Skills lifecycle service",
      services: [
        FixtureSkillsService as ServiceClass,
        AgentSkillsPluginLifecycleService as ServiceClass,
      ],
    };
    const runtime = new AgentRuntime({ logLevel: "fatal" });
    await runtime.initialize({ allowNoDatabase: true, skipMigrations: true });

    try {
      await runtime.registerPlugin(commandsPlugin);
      await runtime.registerPlugin(skillsPlugin);
      const lifecycle = runtime.getServiceLoadPromise(
        AgentSkillsPluginLifecycleService.serviceType,
      );
      await Promise.resolve();
      expect(registeredKeys).toEqual([]);

      commandsStart.resolve();
      await lifecycle;

      expect(registeredKeys).toEqual(["skill-calendar"]);
    } finally {
      commandsStart.resolve();
      await runtime.stop({ fast: true });
    }
  });
});
