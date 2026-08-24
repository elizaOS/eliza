/**
 * Unit tests for `registerCoreSensitiveRequestAdapters`: registration order of
 * the six first-party delivery adapters, per-target uniqueness, the canonical
 * registry service lookup, and the non-registry guard branches (missing or
 * non-callable `register`). Complements, and does not repeat, the standalone
 * registration suite in `__tests__/`.
 */
import {
  SENSITIVE_REQUEST_DISPATCH_REGISTRY_SERVICE,
  type SensitiveRequestDeliveryAdapter,
} from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { registerCoreSensitiveRequestAdapters } from "./index";

describe("registerCoreSensitiveRequestAdapters", () => {
  function makeRecordingRuntime() {
    const registered: SensitiveRequestDeliveryAdapter[] = [];
    const lookedUpServiceNames: string[] = [];
    const runtime = {
      getService: (name: string) => {
        lookedUpServiceNames.push(name);
        return {
          register: (adapter: SensitiveRequestDeliveryAdapter) => {
            registered.push(adapter);
          },
        };
      },
    };
    return { registered, lookedUpServiceNames, runtime };
  }

  it("registers exactly one adapter per first-party target, each with a callable deliver", () => {
    const { registered, runtime } = makeRecordingRuntime();
    registerCoreSensitiveRequestAdapters(runtime);

    expect(registered).toHaveLength(6);
    const targets = registered.map((adapter) => adapter.target);
    expect(new Set(targets).size).toBe(6);
    for (const adapter of registered) {
      expect(typeof adapter.deliver).toBe("function");
    }
  });

  it("registers the adapters in the composed Wave A order", () => {
    const { registered, runtime } = makeRecordingRuntime();
    registerCoreSensitiveRequestAdapters(runtime);

    expect(registered.map((adapter) => adapter.target)).toEqual([
      "owner_app_inline",
      "owner_app_oauth",
      "cloud_authenticated_link",
      "tunnel_authenticated_link",
      "instruct_dm_only",
      "public_link",
    ]);
  });

  it("looks up only the canonical dispatch registry service", () => {
    const { lookedUpServiceNames, runtime } = makeRecordingRuntime();
    registerCoreSensitiveRequestAdapters(runtime);

    expect(lookedUpServiceNames).toEqual([
      SENSITIVE_REQUEST_DISPATCH_REGISTRY_SERVICE,
    ]);
  });

  it("no-ops without throwing when the resolved service lacks a callable register", () => {
    expect(() =>
      registerCoreSensitiveRequestAdapters({
        getService: () => ({ register: "not-a-function" }),
      }),
    ).not.toThrow();

    expect(() =>
      registerCoreSensitiveRequestAdapters({
        getService: () => ({}),
      }),
    ).not.toThrow();
  });

  it("no-ops without throwing when the service resolves to a non-object", () => {
    let serviceLookups = 0;
    expect(() =>
      registerCoreSensitiveRequestAdapters({
        getService: () => {
          serviceLookups += 1;
          return "bogus";
        },
      }),
    ).not.toThrow();
    expect(serviceLookups).toBe(1);
  });
});
