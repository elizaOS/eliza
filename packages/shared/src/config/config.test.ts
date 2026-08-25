/**
 * Unit coverage for cloud provider config migration helpers in config.ts.
 *
 * Tests isCloudActiveFromProviders array search and migrateCloudEnabledToProviders
 * backwards-compatibility upgrade behaviors.
 */

import { describe, expect, it } from "vitest";
import {
  isCloudActiveFromProviders,
  migrateCloudEnabledToProviders,
} from "./config.js";

describe("config cloud providers", () => {
  describe("isCloudActiveFromProviders", () => {
    it("returns true when providers array contains 'elizacloud'", () => {
      expect(isCloudActiveFromProviders(["elizacloud"])).toBe(true);
      expect(
        isCloudActiveFromProviders(["openai", "elizacloud", "anthropic"]),
      ).toBe(true);
    });

    it("returns false when providers does not contain 'elizacloud' or is empty/null/undefined", () => {
      expect(isCloudActiveFromProviders(["openai"])).toBe(false);
      expect(isCloudActiveFromProviders([])).toBe(false);
      expect(isCloudActiveFromProviders(null)).toBe(false);
      expect(isCloudActiveFromProviders(undefined)).toBe(false);
    });
  });

  describe("migrateCloudEnabledToProviders", () => {
    it("returns unchanged config when cloud.enabled is not true", () => {
      const config1 = { cloud: { enabled: false } };
      expect(migrateCloudEnabledToProviders(config1)).toBe(config1);

      const config2 = {};
      expect(migrateCloudEnabledToProviders(config2)).toBe(config2);
    });

    it("appends 'elizacloud' to providers when cloud.enabled is true", () => {
      const config = {
        cloud: { enabled: true },
        providers: ["openai"],
      };

      const migrated = migrateCloudEnabledToProviders(config);
      expect(migrated.providers).toEqual(["openai", "elizacloud"]);
    });

    it("initializes providers array with 'elizacloud' if providers was undefined", () => {
      const config = {
        cloud: { enabled: true },
      };

      const migrated = migrateCloudEnabledToProviders(config);
      expect(migrated.providers).toEqual(["elizacloud"]);
    });

    it("returns unchanged config if 'elizacloud' is already in providers", () => {
      const config = {
        cloud: { enabled: true },
        providers: ["elizacloud"],
      };

      const migrated = migrateCloudEnabledToProviders(config);
      expect(migrated).toBe(config);
    });
  });
});
