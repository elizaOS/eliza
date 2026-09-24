/**
 * Unit coverage for the iOS local-runtime backend policy (`ios-runtime-backends`):
 * backend selection precedence (full Bun engine vs. gated SwiftBun / ITTP
 * compatibility fallbacks), the invariant that every backend stays
 * TypeScript-owned + bridge-only, and the production/App-Store blocker list.
 * Pure in-memory assertions, no simulator.
 */
import { describe, expect, it } from "vitest";
import {
  getIosLocalRuntimeBackendDefinition,
  getIosLocalRuntimeProductionBlockers,
  selectIosLocalRuntimeBackend,
} from "./ios-runtime-backends";

describe("iOS local runtime backend policy", () => {
  it("selects the full Bun engine when the xcframework is available", () => {
    const selection = selectIosLocalRuntimeBackend({
      fullBunEngineAvailable: true,
      requireProductionSafe: true,
    });

    expect(selection.backend).toBe("full-bun-engine");
    expect(selection.definition?.runtimeOwner).toBe("typescript-agent-bundle");
    expect(selection.definition?.nativeRole).toBe("bridge-only");
    expect(selection.definition?.runsInIosAppProcess).toBe(true);
    expect(selection.definition?.supportsCodingAgentsInApp).toBe(false);
    expect(selection.warnings).toEqual([]);
  });

  it("blocks compatibility backends when production-safe local runtime is required", () => {
    const selection = selectIosLocalRuntimeBackend({
      fullBunEngineAvailable: false,
      swiftBunJscoreAvailable: true,
      allowSwiftBunCandidate: true,
      allowIttpCompatibilityFallback: true,
      requireProductionSafe: true,
    });

    expect(selection.backend).toBeNull();
    expect(selection.reason).toContain("ElizaBunEngine.xcframework");
  });

  it("selects SwiftBun only when explicitly enabled", () => {
    const disabled = selectIosLocalRuntimeBackend({
      fullBunEngineAvailable: false,
      swiftBunJscoreAvailable: true,
    });
    const enabled = selectIosLocalRuntimeBackend({
      fullBunEngineAvailable: false,
      swiftBunJscoreAvailable: true,
      allowSwiftBunCandidate: true,
    });

    expect(disabled.backend).toBeNull();
    expect(enabled.backend).toBe("swift-bun-jscore");
    expect(enabled.warnings).toContain(
      "swift-bun-jscore is not approved for production local iOS runtime",
    );
  });

  it("keeps JSContext ITTP as an explicit compatibility fallback", () => {
    const selection = selectIosLocalRuntimeBackend({
      fullBunEngineAvailable: false,
      allowIttpCompatibilityFallback: true,
    });

    expect(selection.backend).toBe("ittp-jscontext");
    expect(selection.definition?.readiness).toBe("compatibility");
    expect(selection.warnings).toContain(
      "ittp-jscontext is not approved for production local iOS runtime",
    );
  });

  it("keeps all backends TypeScript-owned and bridge-only", () => {
    for (const backend of [
      "full-bun-engine",
      "swift-bun-jscore",
      "ittp-jscontext",
    ] as const) {
      const definition = getIosLocalRuntimeBackendDefinition(backend);

      expect(definition.runtimeOwner).toBe("typescript-agent-bundle");
      expect(definition.nativeRole).toBe("bridge-only");
      expect(definition.runsInIosAppProcess).toBe(true);
      expect(definition.supportsCodingAgentsInApp).toBe(false);
      expect(definition.supportsDynamicNativeCode).toBe(false);
    }
  });

  it("approves only full Bun for production local iOS runtime", () => {
    expect(getIosLocalRuntimeProductionBlockers("full-bun-engine")).toEqual([]);
    expect(getIosLocalRuntimeProductionBlockers("swift-bun-jscore")).toContain(
      "swift-bun-jscore is not approved for production local iOS runtime",
    );
    expect(getIosLocalRuntimeProductionBlockers("ittp-jscontext")).toContain(
      "ittp-jscontext is not approved for production local iOS runtime",
    );
  });
});
