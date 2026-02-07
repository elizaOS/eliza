import { describe, expect, it } from "vitest";
import {
  basicCapabilities,
  type CapabilityConfig,
  createBootstrapPlugin,
  extendedCapabilities,
} from "../index";

// Create a bootstrap plugin instance for testing
const bootstrapPlugin = createBootstrapPlugin();

describe("Capability System", () => {
  describe("createBootstrapPlugin", () => {
    it("should include only basic capabilities by default", () => {
      const plugin = createBootstrapPlugin();

      expect(plugin.name).toBe("bootstrap");

      // Should have basic actions
      expect(plugin.actions).toHaveLength(basicCapabilities.actions.length);
      expect(plugin.actions?.map((a) => a.name)).toContain("REPLY");
      expect(plugin.actions?.map((a) => a.name)).toContain("IGNORE");
      expect(plugin.actions?.map((a) => a.name)).toContain("NONE");

      // Should have basic providers
      expect(plugin.providers).toHaveLength(basicCapabilities.providers.length);
      expect(plugin.providers?.map((p) => p.name)).toContain("TIME");
      expect(plugin.providers?.map((p) => p.name)).toContain("RECENT_MESSAGES");

      // Should NOT have extended actions
      expect(plugin.actions?.map((a) => a.name)).not.toContain("CHOICE");
      expect(plugin.actions?.map((a) => a.name)).not.toContain("MUTE_ROOM");
      expect(plugin.actions?.map((a) => a.name)).not.toContain("UPDATE_ROLE");
    });

    it("should include both basic and extended when enableExtended is true", () => {
      const config: CapabilityConfig = { enableExtended: true };
      const plugin = createBootstrapPlugin(config);

      const totalActions =
        basicCapabilities.actions.length + extendedCapabilities.actions.length;
      const totalProviders =
        basicCapabilities.providers.length +
        extendedCapabilities.providers.length;

      expect(plugin.actions).toHaveLength(totalActions);
      expect(plugin.providers).toHaveLength(totalProviders);

      // Should have basic actions
      expect(plugin.actions?.map((a) => a.name)).toContain("REPLY");
      expect(plugin.actions?.map((a) => a.name)).toContain("IGNORE");

      // Should also have extended actions
      expect(plugin.actions?.map((a) => a.name)).toContain("CHOOSE_OPTION");
      expect(plugin.actions?.map((a) => a.name)).toContain("MUTE_ROOM");
      expect(plugin.actions?.map((a) => a.name)).toContain("UNMUTE_ROOM");
      expect(plugin.actions?.map((a) => a.name)).toContain("FOLLOW_ROOM");
      expect(plugin.actions?.map((a) => a.name)).toContain("UNFOLLOW_ROOM");
      expect(plugin.actions?.map((a) => a.name)).toContain("UPDATE_ROLE");

      // Should have extended providers
      expect(plugin.providers?.map((p) => p.name)).toContain("FACTS");
      expect(plugin.providers?.map((p) => p.name)).toContain("ROLES");
      expect(plugin.providers?.map((p) => p.name)).toContain("RELATIONSHIPS");
    });

    it("should exclude basic capabilities when disableBasic is true", () => {
      const config: CapabilityConfig = { disableBasic: true };
      const plugin = createBootstrapPlugin(config);

      // Should have no actions (basic disabled, extended not enabled)
      expect(plugin.actions).toHaveLength(0);
      expect(plugin.providers).toHaveLength(0);
      expect(plugin.evaluators).toHaveLength(0);
      expect(plugin.services).toHaveLength(0);

      // Events should still be present
      expect(plugin.events).toBeDefined();
    });

    it("should include only extended when disableBasic and enableExtended are both true", () => {
      const config: CapabilityConfig = {
        disableBasic: true,
        enableExtended: true,
      };
      const plugin = createBootstrapPlugin(config);

      // Should only have extended capabilities
      expect(plugin.actions).toHaveLength(extendedCapabilities.actions.length);
      expect(plugin.providers).toHaveLength(
        extendedCapabilities.providers.length,
      );

      // Should NOT have basic actions
      expect(plugin.actions?.map((a) => a.name)).not.toContain("REPLY");
      expect(plugin.actions?.map((a) => a.name)).not.toContain("IGNORE");
      expect(plugin.actions?.map((a) => a.name)).not.toContain("NONE");

      // Should have extended actions
      expect(plugin.actions?.map((a) => a.name)).toContain("CHOOSE_OPTION");
      expect(plugin.actions?.map((a) => a.name)).toContain("MUTE_ROOM");
    });
  });

  describe("bootstrapPlugin (default export)", () => {
    it("should be configured with basic capabilities only", () => {
      expect(bootstrapPlugin.name).toBe("bootstrap");
      expect(bootstrapPlugin.actions).toHaveLength(
        basicCapabilities.actions.length,
      );
      expect(bootstrapPlugin.providers).toHaveLength(
        basicCapabilities.providers.length,
      );
      expect(bootstrapPlugin.evaluators).toHaveLength(
        basicCapabilities.evaluators.length,
      );
      expect(bootstrapPlugin.services).toHaveLength(
        basicCapabilities.services.length,
      );
    });

    it("should have events regardless of capability settings", () => {
      expect(bootstrapPlugin.events).toBeDefined();
      expect(Object.keys(bootstrapPlugin.events || {}).length).toBeGreaterThan(
        0,
      );
    });
  });

  describe("Capability arrays", () => {
    it("should have all required basic providers", () => {
      const providerNames = basicCapabilities.providers.map((p) => p.name);
      expect(providerNames).toContain("ACTIONS");
      expect(providerNames).toContain("ACTION_STATE");
      expect(providerNames).toContain("ATTACHMENTS");
      expect(providerNames).toContain("CAPABILITIES");
      expect(providerNames).toContain("CHARACTER");
      expect(providerNames).toContain("ENTITIES");
      expect(providerNames).toContain("EVALUATORS");
      expect(providerNames).toContain("PROVIDERS");
      expect(providerNames).toContain("RECENT_MESSAGES");
      expect(providerNames).toContain("TIME");
      expect(providerNames).toContain("WORLD");
    });

    it("should have all required basic actions", () => {
      const actionNames = basicCapabilities.actions.map((a) => a.name);
      expect(actionNames).toContain("REPLY");
      expect(actionNames).toContain("IGNORE");
      expect(actionNames).toContain("NONE");
    });

    it("should have all required extended providers", () => {
      const providerNames = extendedCapabilities.providers.map((p) => p.name);
      expect(providerNames).toContain("CHOICE");
      expect(providerNames).toContain("FACTS");
      expect(providerNames).toContain("RELATIONSHIPS");
      expect(providerNames).toContain("ROLES");
      expect(providerNames).toContain("SETTINGS");
    });

    it("should have all required extended actions", () => {
      const actionNames = extendedCapabilities.actions.map((a) => a.name);
      expect(actionNames).toContain("CHOOSE_OPTION");
      expect(actionNames).toContain("FOLLOW_ROOM");
      expect(actionNames).toContain("UNFOLLOW_ROOM");
      expect(actionNames).toContain("MUTE_ROOM");
      expect(actionNames).toContain("UNMUTE_ROOM");
      expect(actionNames).toContain("SEND_MESSAGE");
      expect(actionNames).toContain("UPDATE_CONTACT");
      expect(actionNames).toContain("UPDATE_ROLE");
      expect(actionNames).toContain("UPDATE_SETTINGS");
      expect(actionNames).toContain("GENERATE_IMAGE");
    });

    it("should have basic services", () => {
      expect(basicCapabilities.services.length).toBeGreaterThan(0);
    });

    it("should have no basic evaluators (reflection is extended)", () => {
      expect(basicCapabilities.evaluators.length).toBe(0);
    });

    it("should have reflection evaluator in extended", () => {
      expect(extendedCapabilities.evaluators.length).toBeGreaterThan(0);
    });
  });
});
