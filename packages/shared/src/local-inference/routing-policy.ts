/**
 * Browser-safe routing policy contracts shared by UI and runtime consumers.
 */

import type { AgentModelSlot } from "./types.js";

export type RoutingPolicy =
  | "manual"
  | "auto"
  | "local-only"
  | "cloud-only"
  | "cheapest"
  | "fastest"
  | "prefer-local"
  | "round-robin";

export const ROUTING_POLICIES: readonly RoutingPolicy[] = [
  "manual",
  "auto",
  "local-only",
  "cloud-only",
  "cheapest",
  "fastest",
  "prefer-local",
  "round-robin",
] as const;

export function isRoutingPolicy(value: unknown): value is RoutingPolicy {
  return (
    typeof value === "string" &&
    (ROUTING_POLICIES as readonly string[]).includes(value)
  );
}

export const DEFAULT_ROUTING_POLICY: RoutingPolicy = "prefer-local";

export interface RoutingPreferences {
  /** Explicit provider override per agent slot. */
  preferredProvider: Partial<Record<AgentModelSlot, string>>;
  /** Per-slot dispatch policy; absent slots use prefer-local. */
  policy: Partial<Record<AgentModelSlot, RoutingPolicy>>;
}
