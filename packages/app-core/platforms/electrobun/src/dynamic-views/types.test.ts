/** Drives the dynamic-view placement and source vocabulary through the registry validation boundary that consumes it. */
import { describe, expect, it } from "vitest";
import { DynamicViewError } from "./errors";
import { DynamicViewRegistry } from "./registry";
import type {
  DynamicViewManifest,
  DynamicViewPlacement,
  DynamicViewSource,
} from "./types";
import { DYNAMIC_VIEW_PLACEMENTS, DYNAMIC_VIEW_SOURCES } from "./types";

function manifest(
  placement: DynamicViewPlacement,
  source: DynamicViewSource,
  id: string,
): DynamicViewManifest {
  return {
    id,
    title: "Vocabulary Probe",
    source,
    entrypoint: "./probe.html",
    placement,
  };
}

describe("dynamic view placement and source vocabulary", () => {
  it("declares a non-empty placement and source vocabulary so the boundary sweeps below execute", () => {
    expect(DYNAMIC_VIEW_PLACEMENTS.length).toBeGreaterThan(0);
    expect(DYNAMIC_VIEW_SOURCES.length).toBeGreaterThan(0);
  });

  it.each([...DYNAMIC_VIEW_PLACEMENTS].map((placement) => [placement]))(
    "accepts declared placement %s at the registry boundary",
    (placement) => {
      const registry = new DynamicViewRegistry();

      const registered = registry.register(
        manifest(placement, "agent", "vocab.placement"),
      );

      expect(registered.placement).toBe(placement);
      expect(registry.get("vocab.placement")?.placement).toBe(placement);
    },
  );

  it.each([...DYNAMIC_VIEW_SOURCES].map((source) => [source]))(
    "accepts declared source %s at the registry boundary",
    (source) => {
      const registry = new DynamicViewRegistry();

      const registered = registry.register(
        manifest("floating", source, "vocab.source"),
      );

      expect(registered.source).toBe(source);
      expect(registry.get("vocab.source")?.source).toBe(source);
    },
  );

  const INVALID_PLACEMENT_VALUES: unknown[] = [
    undefined,
    null,
    42,
    true,
    {},
    [],
    "",
    "CANVAS",
  ];

  it.each(INVALID_PLACEMENT_VALUES.map((value) => [value]))(
    "rejects placement value %j outside the declared vocabulary",
    (value) => {
      const registry = new DynamicViewRegistry();
      let caught: unknown;

      try {
        registry.register(
          manifest(value as DynamicViewPlacement, "agent", "vocab.invalid"),
        );
      } catch (error) {
        caught = error;
      }

      if (!(caught instanceof DynamicViewError)) {
        throw new Error(
          "register() must reject invalid placement values with DynamicViewError",
        );
      }
      expect(caught.code).toBe("DYNAMIC_VIEW_INVALID_MANIFEST");
      expect(caught.message).toContain("Unsupported dynamic view placement");
      expect(registry.list()).toHaveLength(0);
    },
  );

  const INVALID_SOURCE_VALUES: unknown[] = [
    undefined,
    null,
    42,
    true,
    {},
    [],
    "",
    "AGENT",
  ];

  it.each(INVALID_SOURCE_VALUES.map((value) => [value]))(
    "rejects source value %j outside the declared vocabulary",
    (value) => {
      const registry = new DynamicViewRegistry();
      let caught: unknown;

      try {
        registry.register(
          manifest("floating", value as DynamicViewSource, "vocab.invalid"),
        );
      } catch (error) {
        caught = error;
      }

      if (!(caught instanceof DynamicViewError)) {
        throw new Error(
          "register() must reject invalid source values with DynamicViewError",
        );
      }
      expect(caught.code).toBe("DYNAMIC_VIEW_INVALID_MANIFEST");
      expect(caught.message).toContain("Unsupported dynamic view source");
      expect(registry.list()).toHaveLength(0);
    },
  );
});
