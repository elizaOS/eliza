import type { UUID } from "@elizaos/core";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function hashSegment(input: string, seed: number): number {
  let hash = seed >>> 0;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function stringToUuid(target: string | number): UUID {
  const value = typeof target === "number" ? target.toString() : target;

  if (typeof value !== "string") {
    throw new TypeError("Value must be string");
  }

  if (UUID_PATTERN.test(value)) {
    return value as UUID;
  }

  const input = encodeURIComponent(value);
  const hex = [
    hashSegment(input, 0x811c9dc5),
    hashSegment(input, 0x9e3779b1),
    hashSegment(input, 0x85ebca6b),
    hashSegment(input, 0xc2b2ae35),
  ]
    .map((part) => part.toString(16).padStart(8, "0"))
    .join("")
    .slice(0, 32)
    .split("");

  hex[12] = "0";
  hex[16] = ((Number.parseInt(hex[16] ?? "0", 16) & 0x3) | 0x8).toString(16);

  return `${hex.slice(0, 8).join("")}-${hex.slice(8, 12).join("")}-${hex
    .slice(12, 16)
    .join("")}-${hex.slice(16, 20).join("")}-${hex.slice(20, 32).join("")}` as UUID;
}
