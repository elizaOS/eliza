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
import type {
  AgentModelSlot,
  ExternalLlmAutodetectFocus,
  ExternalLlmRuntimeId,
} from "./types";

export type RoutingPolicy =
  | "manual"
  | "cheapest"
  | "fastest"
  | "prefer-local"
  | "round-robin";

export interface RoutingPreferences {
  /**
   * Explicit provider override per agent slot. Empty record = no overrides,
   * runtime picks the highest-priority registered handler.
   */
  preferredProvider: Partial<Record<AgentModelSlot, string>>;
  /**
   * Per-slot policy. "manual" honours `preferredProvider` verbatim;
   * everything else lets the router-handler compute a winner from the
   * policy rule set. Absent = "manual" (matches the legacy behaviour).
   */
  policy: Partial<Record<AgentModelSlot, RoutingPolicy>>;
  /**
   * When suppressing in-app GGUF against external stacks, which probed row
   * counts as “external ready”. **`any`** (default) = any Ollama/LM Studio/vLLM/Jan
   * row with `routerInferenceReady`; a stack id = only that row.
   */
  externalLlmAutodetectFocus?: ExternalLlmAutodetectFocus;
}

interface RoutingFile {
  version: 1;
  preferences: RoutingPreferences;
}

const EMPTY: RoutingPreferences = { preferredProvider: {}, policy: {} };

const EXTERNAL_LLM_RUNTIME_IDS: readonly ExternalLlmRuntimeId[] = [
  "ollama",
  "lmstudio",
  "vllm",
  "jan",
];

function parseStoredExternalLlmAutodetectFocus(
  raw: unknown,
): ExternalLlmAutodetectFocus | undefined {
  if (typeof raw !== "string" || raw.trim().length === 0) return undefined;
  const v = raw.trim() as ExternalLlmAutodetectFocus;
  if (v === "any") return undefined;
  if (v === "milady-gguf") return "milady-gguf";
  return EXTERNAL_LLM_RUNTIME_IDS.includes(v as ExternalLlmRuntimeId)
    ? (v as ExternalLlmRuntimeId)
    : undefined;
}

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
    const focus = parseStoredExternalLlmAutodetectFocus(
      parsed.preferences.externalLlmAutodetectFocus,
    );
    return {
      preferredProvider: parsed.preferences.preferredProvider ?? {},
      policy: parsed.preferences.policy ?? {},
      ...(focus ? { externalLlmAutodetectFocus: focus } : {}),
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
    ...(current.externalLlmAutodetectFocus !== undefined
      ? { externalLlmAutodetectFocus: current.externalLlmAutodetectFocus }
      : {}),
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
    ...(current.externalLlmAutodetectFocus !== undefined
      ? { externalLlmAutodetectFocus: current.externalLlmAutodetectFocus }
      : {}),
  };
  if (policy) {
    next.policy[slot] = policy;
  } else {
    delete next.policy[slot];
  }
  await writeRoutingPreferences(next);
  return next;
}

const EXTERNAL_LLM_AUTODETECT_IDS = new Set<ExternalLlmAutodetectFocus>([
  "any",
  "milady-gguf",
  ...EXTERNAL_LLM_RUNTIME_IDS,
]);

export async function setExternalLlmAutodetectFocus(
  focus: ExternalLlmAutodetectFocus,
): Promise<RoutingPreferences> {
  if (!EXTERNAL_LLM_AUTODETECT_IDS.has(focus)) {
    throw new Error(`Invalid externalLlmAutodetectFocus: ${focus}`);
  }
  const current = await readRoutingPreferences();
  const next: RoutingPreferences = {
    preferredProvider: { ...current.preferredProvider },
    policy: { ...current.policy },
  };
  if (focus === "any") {
    delete next.externalLlmAutodetectFocus;
  } else {
    next.externalLlmAutodetectFocus = focus;
  }
  await writeRoutingPreferences(next);
  return next;
}
