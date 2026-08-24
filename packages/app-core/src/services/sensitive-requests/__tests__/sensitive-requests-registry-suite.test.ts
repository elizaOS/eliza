/**
 * Unit tests for sensitive-request delivery adapter registration.
 * Validates adapter enumeration, runtime service lookup guards, and registration callbacks.
 */

import {
  SENSITIVE_REQUEST_DISPATCH_REGISTRY_SERVICE,
  type SensitiveRequestDeliveryAdapter,
} from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import {
  cloudLinkSensitiveRequestAdapter,
  instructDmOnlySensitiveRequestAdapter,
  ownerAppInlineSensitiveRequestAdapter,
  ownerAppOAuthSensitiveRequestAdapter,
  publicLinkSensitiveRequestAdapter,
  registerCoreSensitiveRequestAdapters,
  tunnelLinkSensitiveRequestAdapter,
} from "../index.ts";

describe("sensitive-requests/index", () => {
  describe("registerCoreSensitiveRequestAdapters", () => {
    it("safely skips when runtime does not have getService", () => {
      expect(() => registerCoreSensitiveRequestAdapters({})).not.toThrow();
      expect(() =>
        registerCoreSensitiveRequestAdapters({ getService: undefined }),
      ).not.toThrow();
    });

    it("safely skips when registry service is not registered in runtime", () => {
      const fakeRuntime = {
        getService: vi.fn().mockReturnValue(null),
      };
      expect(() =>
        registerCoreSensitiveRequestAdapters(fakeRuntime),
      ).not.toThrow();
      expect(fakeRuntime.getService).toHaveBeenCalledWith(
        SENSITIVE_REQUEST_DISPATCH_REGISTRY_SERVICE,
      );
    });

    it("safely skips when returned service object has no register method", () => {
      const fakeRuntime = {
        getService: vi.fn().mockReturnValue({ invalid: true }),
      };
      expect(() =>
        registerCoreSensitiveRequestAdapters(fakeRuntime),
      ).not.toThrow();
    });

    it("registers all 6 first-party delivery adapters when registry is present", () => {
      const registered: SensitiveRequestDeliveryAdapter[] = [];
      const fakeRegistry = {
        register: vi.fn((adapter: SensitiveRequestDeliveryAdapter) => {
          registered.push(adapter);
        }),
      };
      const fakeRuntime = {
        getService: vi.fn().mockReturnValue(fakeRegistry),
      };

      registerCoreSensitiveRequestAdapters(fakeRuntime);

      expect(fakeRegistry.register).toHaveBeenCalledTimes(6);
      expect(registered).toContain(ownerAppInlineSensitiveRequestAdapter);
      expect(registered).toContain(ownerAppOAuthSensitiveRequestAdapter);
      expect(registered).toContain(cloudLinkSensitiveRequestAdapter);
      expect(registered).toContain(tunnelLinkSensitiveRequestAdapter);
      expect(registered).toContain(instructDmOnlySensitiveRequestAdapter);
      expect(registered).toContain(publicLinkSensitiveRequestAdapter);
    });
  });
});
