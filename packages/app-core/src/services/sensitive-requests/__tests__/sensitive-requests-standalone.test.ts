/**
 * Unit tests for core sensitive request delivery adapter registration.
 */
import {
  SENSITIVE_REQUEST_DISPATCH_REGISTRY_SERVICE,
  type SensitiveRequestDeliveryAdapter,
} from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  cloudLinkSensitiveRequestAdapter,
  instructDmOnlySensitiveRequestAdapter,
  ownerAppInlineSensitiveRequestAdapter,
  ownerAppOAuthSensitiveRequestAdapter,
  publicLinkSensitiveRequestAdapter,
  registerCoreSensitiveRequestAdapters,
  tunnelLinkSensitiveRequestAdapter,
} from "../index.ts";

describe("sensitive-requests registration", () => {
  it("registers all 6 first-party delivery adapters when registry service is present", () => {
    const registered: SensitiveRequestDeliveryAdapter[] = [];
    const mockRegistry = {
      register: (adapter: SensitiveRequestDeliveryAdapter) => {
        registered.push(adapter);
      },
    };

    const mockRuntime = {
      getService: (serviceName: string) => {
        if (serviceName === SENSITIVE_REQUEST_DISPATCH_REGISTRY_SERVICE) {
          return mockRegistry;
        }
        return null;
      },
    };

    registerCoreSensitiveRequestAdapters(mockRuntime);

    expect(registered).toHaveLength(6);
    expect(registered).toContain(ownerAppInlineSensitiveRequestAdapter);
    expect(registered).toContain(ownerAppOAuthSensitiveRequestAdapter);
    expect(registered).toContain(cloudLinkSensitiveRequestAdapter);
    expect(registered).toContain(tunnelLinkSensitiveRequestAdapter);
    expect(registered).toContain(instructDmOnlySensitiveRequestAdapter);
    expect(registered).toContain(publicLinkSensitiveRequestAdapter);
  });

  it("safely no-ops when runtime does not have getService or registry service is missing", () => {
    expect(() => registerCoreSensitiveRequestAdapters({})).not.toThrow();
    expect(() =>
      registerCoreSensitiveRequestAdapters({
        getService: () => null,
      }),
    ).not.toThrow();
  });
});
