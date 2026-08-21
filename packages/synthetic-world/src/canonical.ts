/**
 * Produces process-independent canonical JSON, hashes, stable fixture IDs, and
 * seeded pseudo-random values for reproducible synthetic worlds.
 */
import { createHash } from "node:crypto";
import type { JsonValue } from "./manifest.ts";

function sortJson(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, sortJson(child)]),
    );
  }
  return value;
}

export function canonicalJson(value: JsonValue): string {
  return JSON.stringify(sortJson(value));
}

export function payloadHash(value: JsonValue): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function stableFixtureId(
  worldId: string,
  kind: string,
  key: string,
): string {
  const suffix = createHash("sha256")
    .update(`${worldId}\0${kind}\0${key}`)
    .digest("hex")
    .slice(0, 24);
  return `${kind}_${suffix}`;
}

export class DeterministicRandom {
  private state: number;

  public constructor(seed: string) {
    const digest = createHash("sha256").update(seed).digest();
    this.state = digest.readUInt32LE(0) || 1;
  }

  public next(): number {
    let value = this.state;
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    this.state = value >>> 0;
    return this.state / 0x1_0000_0000;
  }

  public integer(minInclusive: number, maxExclusive: number): number {
    if (
      !Number.isInteger(minInclusive) ||
      !Number.isInteger(maxExclusive) ||
      maxExclusive <= minInclusive
    ) {
      throw new RangeError(
        "DeterministicRandom.integer requires a non-empty integer range",
      );
    }
    return (
      minInclusive + Math.floor(this.next() * (maxExclusive - minInclusive))
    );
  }

  public snapshot(): { readonly state: number } {
    return { state: this.state };
  }
}
