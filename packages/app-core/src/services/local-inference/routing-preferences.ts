/**
 * Per-model-type user override: "for TEXT_LARGE, prefer this provider".
 *
 * Persisted to `$STATE_DIR/local-inference/routing.json` and read by the
 * router-handler (see `router-handler.ts`) to pick a provider at dispatch
 * time. When a slot has no override, the runtime's native priority order
 * wins — i.e. this is layered over the existing registration priority
 * rather than replacing it.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { localInferenceRoot } from "./paths";
import type { AgentModelSlot } from "./types";

export type RoutingPolicy =
  | "manual"
  | "cheapest"
  | "fastest"
  | "prefer-local"
  | "round-robin";

export const DEFAULT_ROUTING_POLICY: RoutingPolicy = "prefer-local";

export interface RoutingPreferences {
  /**
   * Explicit provider override per agent slot. Empty record = no overrides,
   * runtime picks the highest-priority registered handler.
   */
  preferredProvider: Partial<Record<AgentModelSlot, string>>;
  /**
   * Per-slot policy. "manual" honours `preferredProvider` verbatim;
   * everything else lets the router-handler compute a winner from the
   * policy rule set. Absent = "prefer-local" so local models and
   * subscriptions are tried before direct paid APIs and managed cloud.
   */
  policy: Partial<Record<AgentModelSlot, RoutingPolicy>>;
}

interface RoutingFile {
  version: 1;
  preferences: RoutingPreferences;
}

const EMPTY: RoutingPreferences = { preferredProvider: {}, policy: {} };

function routingPath(): string {
  return path.join(localInferenceRoot(), "routing.json");
}

async function ensureRoot(): Promise<void> {
  await fs.mkdir(localInferenceRoot(), { recursive: true });
}

export async function readRoutingPreferences(): Promise<RoutingPreferences> {
  try {
    const raw = await fs.readFile(routingPath(), "utf8");
    const parsed = JSON.parse(raw) as RoutingFile;
    if (!parsed || parsed.version !== 1 || !parsed.preferences) return EMPTY;
    return {
      preferredProvider: parsed.preferences.preferredProvider ?? {},
      policy: parsed.preferences.policy ?? {},
    };
  } catch {
    return EMPTY;
  }
}

export async function writeRoutingPreferences(
  prefs: RoutingPreferences,
): Promise<void> {
  await ensureRoot();
  const payload: RoutingFile = { version: 1, preferences: prefs };
  const tmp = `${routingPath()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(payload, null, 2), "utf8");
  await fs.rename(tmp, routingPath());
}

export async function setPreferredProvider(
  slot: AgentModelSlot,
  provider: string | null,
): Promise<RoutingPreferences> {
  const current = await readRoutingPreferences();
  const next: RoutingPreferences = {
    preferredProvider: { ...current.preferredProvider },
    policy: { ...current.policy },
  };
  if (provider) {
    next.preferredProvider[slot] = provider;
  } else {
    delete next.preferredProvider[slot];
  }
  await writeRoutingPreferences(next);
  return next;
}

export async function setPolicy(
  slot: AgentModelSlot,
  policy: RoutingPolicy | null,
): Promise<RoutingPreferences> {
  const current = await readRoutingPreferences();
  const next: RoutingPreferences = {
    preferredProvider: { ...current.preferredProvider },
    policy: { ...current.policy },
  };
  if (policy) {
    next.policy[slot] = policy;
  } else {
    delete next.policy[slot];
  }
  await writeRoutingPreferences(next);
  return next;
}
