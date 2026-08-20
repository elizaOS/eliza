/**
 * Applies declarative scenario overlays by merging entity collections on their
 * stable IDs while leaving the base manifest immutable.
 */
import {
  type JsonValue,
  parseWorldManifest,
  type WorldData,
  type WorldManifest,
} from "./manifest.ts";

export interface WorldOverlay {
  readonly seed?: string;
  readonly clock?: Partial<WorldManifest["clock"]>;
  readonly data?: Partial<WorldData>;
  readonly faults?: WorldManifest["faults"];
}

function isEntityArray(value: unknown): value is Array<{ id: string }> {
  return (
    Array.isArray(value) &&
    value.every(
      (item) => typeof item === "object" && item !== null && "id" in item,
    )
  );
}

export function applyWorldOverlay(
  baseInput: WorldManifest,
  overlay: WorldOverlay,
): WorldManifest {
  const base = structuredClone(baseInput);
  const data = structuredClone(base.data) as Record<string, JsonValue>;
  for (const [key, overlayValue] of Object.entries(overlay.data ?? {})) {
    const baseValue = data[key];
    if (isEntityArray(baseValue) && isEntityArray(overlayValue)) {
      const merged = new Map(baseValue.map((entity) => [entity.id, entity]));
      for (const entity of overlayValue) merged.set(entity.id, entity);
      data[key] = [...merged.values()] as JsonValue;
    } else {
      data[key] = structuredClone(overlayValue) as JsonValue;
    }
  }
  return parseWorldManifest({
    ...base,
    seed: overlay.seed ?? base.seed,
    clock: { ...base.clock, ...overlay.clock },
    data,
    faults: overlay.faults ?? base.faults,
  });
}
