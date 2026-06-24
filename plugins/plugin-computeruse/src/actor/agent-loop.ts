/**
 * Agent-loop registry (#9170 M10).
 *
 * trycua/cua selects an agent *loop* from a model string: an `anthropic/...`
 * model routes to the Claude computer-use loop, `openai/computer-use-preview`
 * routes to the OpenAI operator loop, an OmniParser/grounder string routes to a
 * local set-of-marks loop, etc. Each loop implements the same two-call seam —
 * `predict_step` (observe + plan the next action) and `predict_click` (ground a
 * target to a coordinate) — so the runner is decoupled from *how* a step is
 * produced.
 *
 * elizaOS shipped a single hardcoded Brain→Cascade (ScreenSeekeR). This module
 * replaces that hardcoding with a registry:
 *   - `AgentLoop` — the `predictStep` / `predictClick` seam.
 *   - `registerAgentLoop` — register a loop keyed by a model-string matcher.
 *   - `createAgentLoop(modelString, deps)` — pick the highest-priority matching
 *     loop and instantiate it.
 *
 * The built-in `local-grounder` loop wraps the existing Brain→Cascade and
 * exposes the M5 grounding cache through `predictClick`. Anthropic / OpenAI
 * computer-use loops are *pluggable*: a provider plugin calls
 * `registerAgentLoop` with `matchesModelFamily("anthropic")` (etc.) and its own
 * `predictStep`. With none registered, every model string falls through to the
 * local grounder (which always matches at the lowest priority).
 */

import type { IAgentRuntime } from "@elizaos/core";
import type { DisplayCapture } from "../platform/capture.js";
import type { Scene } from "../scene/scene-types.js";
import { type Actor, OcrCoordinateGroundingActor } from "./actor.js";
import { Brain } from "./brain.js";
import { Cascade, getRegisteredActor } from "./cascade.js";
import type { CascadeResult, GroundingResult } from "./types.js";

/** Default loop model-string — the local OCR/AX + actor grounder. */
export const DEFAULT_AGENT_LOOP_MODEL = "local-grounder";

/** Setting / env key the runner reads to choose a loop. */
export const AGENT_LOOP_SETTING = "COMPUTER_USE_AGENT_LOOP";

export interface AgentStepInput {
  scene: Scene;
  goal: string;
  captures: Map<number, DisplayCapture>;
}

export interface PredictClickInput {
  scene: Scene;
  captures: Map<number, DisplayCapture>;
  targetDisplayId: number;
  /** OCR/AX id to ground (`t<d>-<n>` / `a<d>-<n>`). */
  ref?: string;
  /** Free-form instruction when no ref is available. */
  instruction?: string;
}

/**
 * The two-call seam every loop implements. `predictStep` plans the next
 * concrete action; `predictClick` grounds a target to a coordinate (used by
 * loops that plan elsewhere but reuse our grounding, and by callers that want
 * grounding without a full step).
 */
export interface AgentLoop {
  readonly name: string;
  predictStep(input: AgentStepInput): Promise<CascadeResult>;
  predictClick(input: PredictClickInput): Promise<GroundingResult | null>;
}

export interface AgentLoopDeps {
  runtime: IAgentRuntime | null;
  /** Latest-scene accessor for the default actor. */
  getScene: () => Scene | null;
  /** Brain override (mostly tests). */
  brain?: Brain;
  /** Actor override (mostly tests). */
  actor?: Actor | null;
}

export interface AgentLoopRegistration {
  /** Stable id for telemetry + explicit selection. */
  readonly name: string;
  /** True when this loop handles `modelString`. */
  matches: (modelString: string) => boolean;
  /** Instantiate the loop for a run. */
  create: (deps: AgentLoopDeps) => AgentLoop;
  /** Higher wins when multiple registrations match. Default 0. */
  priority?: number;
}

// ── Built-in: local OCR/AX + actor grounder (Brain → Cascade) ────────────────

/**
 * Wraps the existing ScreenSeekeR (Brain → Cascade). `predictStep` is the full
 * observe→plan→ground cascade; `predictClick` calls the cascade's grounding-only
 * path so the M5 per-Scene grounding cache is shared across both.
 */
export class LocalGrounderLoop implements AgentLoop {
  readonly name = DEFAULT_AGENT_LOOP_MODEL;
  private readonly cascade: Cascade;

  constructor(deps: AgentLoopDeps) {
    const brain = deps.brain ?? new Brain(deps.runtime);
    const actor =
      deps.actor ??
      getRegisteredActor() ??
      new OcrCoordinateGroundingActor(deps.getScene);
    this.cascade = new Cascade({ brain, actor });
  }

  predictStep(input: AgentStepInput): Promise<CascadeResult> {
    return this.cascade.run(input);
  }

  async predictClick(
    input: PredictClickInput,
  ): Promise<GroundingResult | null> {
    const coords = await this.cascade.groundTarget({
      scene: input.scene,
      captures: input.captures,
      targetDisplayId: input.targetDisplayId,
      ref: input.ref,
      instruction: input.instruction,
    });
    if (!coords) return null;
    return {
      displayId: coords.displayId,
      x: coords.x,
      y: coords.y,
      confidence: 1,
      reason: input.ref ?? input.instruction ?? "grounded",
    };
  }

  /** Grounding cache hit/miss snapshot (delegates to the wrapped cascade). */
  getGroundStats() {
    return this.cascade.getGroundStats();
  }
}

// ── Model-string helpers ─────────────────────────────────────────────────────

/**
 * A matcher for a provider family — `anthropic`, `openai`, `google`, … A
 * pluggable loop registers with `matches: matchesModelFamily("anthropic")` so a
 * model string like `anthropic/claude-...` or `claude-3-7-sonnet` routes to it.
 */
export function matchesModelFamily(
  family: string,
): (modelString: string) => boolean {
  const f = family.trim().toLowerCase();
  return (modelString: string): boolean => {
    const m = modelString.trim().toLowerCase();
    return (
      m === f ||
      m.startsWith(`${f}/`) ||
      m.startsWith(`${f}-`) ||
      m.includes(`/${f}/`) ||
      m.includes(f)
    );
  };
}

// ── Registry ─────────────────────────────────────────────────────────────────

const REGISTRY = new Map<string, AgentLoopRegistration>();

/** Register (or replace, by name) an agent-loop. */
export function registerAgentLoop(registration: AgentLoopRegistration): void {
  REGISTRY.set(registration.name, registration);
}

export function unregisterAgentLoop(name: string): void {
  REGISTRY.delete(name);
}

export function listAgentLoops(): readonly AgentLoopRegistration[] {
  return [...REGISTRY.values()].sort(
    (a, b) => (b.priority ?? 0) - (a.priority ?? 0),
  );
}

/**
 * The built-in local grounder. Registered at module load with the lowest
 * priority and a match-anything predicate, so it is always the fallback.
 */
const LOCAL_GROUNDER_REGISTRATION: AgentLoopRegistration = {
  name: DEFAULT_AGENT_LOOP_MODEL,
  // Matches the explicit name plus common local/grounder aliases; also the
  // universal fallback (every string) because its priority is the floor.
  matches: (modelString: string): boolean => {
    const m = modelString.trim().toLowerCase();
    return (
      m === "" ||
      m === DEFAULT_AGENT_LOOP_MODEL ||
      m === "local" ||
      m === "omniparser" ||
      m === "screenseeker" ||
      true
    );
  },
  create: (deps) => new LocalGrounderLoop(deps),
  priority: Number.NEGATIVE_INFINITY,
};
registerAgentLoop(LOCAL_GROUNDER_REGISTRATION);

/**
 * Pick the registration for a model string: the highest-priority one whose
 * `matches` returns true. The local grounder's match-anything floor guarantees
 * a result, so this never throws.
 */
export function selectAgentLoopRegistration(
  modelString: string,
): AgentLoopRegistration {
  let best: AgentLoopRegistration | null = null;
  let bestPriority = Number.NEGATIVE_INFINITY;
  for (const reg of REGISTRY.values()) {
    if (!reg.matches(modelString)) continue;
    const p = reg.priority ?? 0;
    // Strictly-greater keeps the first registrant on ties — but the local
    // grounder sits at -Infinity so any real loop outranks it.
    if (best === null || p > bestPriority) {
      best = reg;
      bestPriority = p;
    }
  }
  // The local grounder always matches, so `best` is non-null here.
  return best ?? LOCAL_GROUNDER_REGISTRATION;
}

/** Resolve + instantiate the loop for a model string. */
export function createAgentLoop(
  modelString: string,
  deps: AgentLoopDeps,
): AgentLoop {
  return selectAgentLoopRegistration(modelString).create(deps);
}

/** Test helper — restore the registry to just the built-in local grounder. */
export function _resetAgentLoopsForTests(): void {
  REGISTRY.clear();
  registerAgentLoop(LOCAL_GROUNDER_REGISTRATION);
}
