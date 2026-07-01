/**
 * Agent-loop callback middleware (#9170 M11).
 *
 * trycua/cua threads a callback pipeline through its agent loop: budget caps,
 * image-retention (keep only the N most-recent screenshots in context),
 * operator-normalization (clean up the model's proposed action), and trajectory
 * recording. Each callback is a thin middleware that observes (and sometimes
 * transforms or aborts) the loop without the loop knowing which middlewares are
 * present.
 *
 * This module defines the `AgentMiddleware` hook set and four built-ins. The
 * runner (`use-computer-agent.ts`) fires the hooks at fixed points:
 *   onRunStart → [ beforeStep → onCaptures → transformProposed → afterStep ]* →
 *   onRunEnd
 *
 * Middlewares are pure-by-default and composable: `runBeforeStep`, etc.,
 * fold the list in order and short-circuit on the first abort.
 */

import { logger } from "@elizaos/core";
import type { DisplayCapture } from "../platform/capture.js";
import type { CascadeResult, ProposedAction } from "./types.js";

export interface AgentRunContext {
  goal: string;
  maxSteps: number;
}

export interface AgentStepContext {
  step: number;
  maxSteps: number;
  goal: string;
  /** Wall-clock ms since the run started (set by the runner). */
  elapsedMs: number;
}

export interface AgentDispatchContext {
  step: number;
  goal: string;
  proposed: CascadeResult;
  dispatchSuccess: boolean;
  error?: string;
}

/** Returned by `beforeStep` — abort halts the loop with `reason`. */
export interface AgentStepDecision {
  abort?: boolean;
  reason?: string;
}

export interface AgentRunSummary {
  goal: string;
  steps: number;
  finished: boolean;
  reason: string;
}

export interface AgentMiddleware {
  readonly name: string;
  onRunStart?(ctx: AgentRunContext): void | Promise<void>;
  /** Inspect/abort before a step runs (budget caps live here). */
  beforeStep?(
    ctx: AgentStepContext,
  ): AgentStepDecision | Promise<AgentStepDecision>;
  /** Observe the captured frames (image-retention bookkeeping). */
  onCaptures?(
    captures: Map<number, DisplayCapture>,
    ctx: AgentStepContext,
  ): void | Promise<void>;
  /** Transform the planned step before dispatch (operator-normalizer). */
  transformProposed?(
    proposed: CascadeResult,
    ctx: AgentStepContext,
  ): CascadeResult | Promise<CascadeResult>;
  /** Observe a dispatched step (trajectory recording). */
  afterStep?(ctx: AgentDispatchContext): void | Promise<void>;
  onRunEnd?(summary: AgentRunSummary): void | Promise<void>;
}

// ── Pipeline folds ───────────────────────────────────────────────────────────

export async function runOnRunStart(
  middlewares: readonly AgentMiddleware[],
  ctx: AgentRunContext,
): Promise<void> {
  for (const m of middlewares) await m.onRunStart?.(ctx);
}

/** Fold `beforeStep`; the FIRST abort wins (and names the middleware). */
export async function runBeforeStep(
  middlewares: readonly AgentMiddleware[],
  ctx: AgentStepContext,
): Promise<AgentStepDecision> {
  for (const m of middlewares) {
    const decision = await m.beforeStep?.(ctx);
    if (decision?.abort) {
      return {
        abort: true,
        reason: decision.reason ?? `aborted by ${m.name}`,
      };
    }
  }
  return { abort: false };
}

export async function runOnCaptures(
  middlewares: readonly AgentMiddleware[],
  captures: Map<number, DisplayCapture>,
  ctx: AgentStepContext,
): Promise<void> {
  for (const m of middlewares) await m.onCaptures?.(captures, ctx);
}

/** Fold `transformProposed` left-to-right; each sees the prior's output. */
export async function runTransformProposed(
  middlewares: readonly AgentMiddleware[],
  proposed: CascadeResult,
  ctx: AgentStepContext,
): Promise<CascadeResult> {
  let current = proposed;
  for (const m of middlewares) {
    if (m.transformProposed) current = await m.transformProposed(current, ctx);
  }
  return current;
}

export async function runAfterStep(
  middlewares: readonly AgentMiddleware[],
  ctx: AgentDispatchContext,
): Promise<void> {
  for (const m of middlewares) await m.afterStep?.(ctx);
}

export async function runOnRunEnd(
  middlewares: readonly AgentMiddleware[],
  summary: AgentRunSummary,
): Promise<void> {
  for (const m of middlewares) await m.onRunEnd?.(summary);
}

// ── Built-in: budget cap ─────────────────────────────────────────────────────

export interface BudgetCapOptions {
  /** Abort once this many steps have STARTED (independent of the loop's own
   * maxSteps; use to cap below it, e.g. cost control). */
  maxSteps?: number;
  /** Abort once wall-clock elapsed exceeds this many ms. */
  maxDurationMs?: number;
}

/**
 * Halts the loop when a step or time budget is exhausted. Caps below the loop's
 * own `maxSteps`, and adds a wall-clock cap the loop has no notion of.
 */
export function createBudgetCapMiddleware(
  options: BudgetCapOptions,
): AgentMiddleware {
  return {
    name: "budget-cap",
    beforeStep(ctx): AgentStepDecision {
      if (options.maxSteps !== undefined && ctx.step > options.maxSteps) {
        return {
          abort: true,
          reason: `step budget exhausted (${options.maxSteps})`,
        };
      }
      if (
        options.maxDurationMs !== undefined &&
        ctx.elapsedMs > options.maxDurationMs
      ) {
        return {
          abort: true,
          reason: `time budget exhausted (${options.maxDurationMs}ms)`,
        };
      }
      return { abort: false };
    },
  };
}

// ── Built-in: image retention (only-N-recent) ────────────────────────────────

export interface ImageRetentionMiddleware extends AgentMiddleware {
  /** The display-keyed captures retained from the most recent steps. */
  retained(): Array<{ step: number; displayIds: number[] }>;
}

/**
 * Bounds the screenshot history to the `keepLast` most-recent steps, mirroring
 * cua's image-retention (older frames fall out of context to cap token cost).
 * The runner forwards the per-step captures; this middleware keeps the bounded
 * window that a model-history consumer should send.
 */
export function createImageRetentionMiddleware(options: {
  keepLast: number;
}): ImageRetentionMiddleware {
  const keepLast = Math.max(1, Math.floor(options.keepLast));
  const window: Array<{ step: number; displayIds: number[] }> = [];
  return {
    name: "image-retention",
    onCaptures(captures, ctx): void {
      window.push({ step: ctx.step, displayIds: [...captures.keys()] });
      while (window.length > keepLast) window.shift();
    },
    retained() {
      return window.map((w) => ({
        step: w.step,
        displayIds: [...w.displayIds],
      }));
    },
  };
}

// ── Built-in: operator normalizer ────────────────────────────────────────────

/** Round a coordinate-like field to an integer when present. Pure. */
function roundIfNumber(n: number | undefined): number | undefined {
  return typeof n === "number" && Number.isFinite(n) ? Math.round(n) : n;
}

/**
 * Normalize the model's proposed action into the canonical dispatch shape:
 * integer coordinates, trimmed type text, deduped/lowercased hotkey keys. Pure
 * and idempotent — re-normalizing already-clean input is a no-op.
 */
export function normalizeProposedAction(
  action: ProposedAction,
): ProposedAction {
  const next: ProposedAction = { ...action };
  next.x = roundIfNumber(next.x);
  next.y = roundIfNumber(next.y);
  next.startX = roundIfNumber(next.startX);
  next.startY = roundIfNumber(next.startY);
  next.dx = roundIfNumber(next.dx);
  next.dy = roundIfNumber(next.dy);
  if (typeof next.text === "string")
    next.text = next.text.replace(/\r\n/g, "\n");
  if (Array.isArray(next.keys)) {
    const seen = new Set<string>();
    next.keys = next.keys
      .map((k) => k.trim())
      .filter((k) => k.length > 0 && !seen.has(k) && seen.add(k));
  }
  return next;
}

/** Operator-normalizer middleware — cleans `proposed.proposed` before dispatch. */
export function createOperatorNormalizerMiddleware(): AgentMiddleware {
  return {
    name: "operator-normalizer",
    transformProposed(proposed): CascadeResult {
      return {
        ...proposed,
        proposed: normalizeProposedAction(proposed.proposed),
      };
    },
  };
}

// ── Built-in: trajectory recorder ────────────────────────────────────────────

export interface TrajectoryEntry {
  step: number;
  goal: string;
  actionKind: string;
  rationale: string;
  success: boolean;
  error?: string;
}

export interface TrajectoryMiddleware extends AgentMiddleware {
  /** The recorded trajectory so far. */
  entries(): TrajectoryEntry[];
}

/**
 * Records one entry per dispatched step. Independent of the existing
 * `logger.info` trajectory events — this gives an in-memory transcript the
 * caller can attach to the run report or persist.
 */
export function createTrajectoryMiddleware(options?: {
  /** Also emit a debug log line per step. Default false. */
  log?: boolean;
}): TrajectoryMiddleware {
  const recorded: TrajectoryEntry[] = [];
  return {
    name: "trajectory",
    afterStep(ctx): void {
      const entry: TrajectoryEntry = {
        step: ctx.step,
        goal: ctx.goal,
        actionKind: ctx.proposed.proposed.kind,
        rationale: ctx.proposed.proposed.rationale,
        success: ctx.dispatchSuccess,
        ...(ctx.error ? { error: ctx.error } : {}),
      };
      recorded.push(entry);
      if (options?.log) {
        logger.debug(
          `[computeruse/agent] trajectory step ${entry.step}: ${entry.actionKind} (${entry.success ? "ok" : "fail"})`,
        );
      }
    },
    entries() {
      return recorded.map((e) => ({ ...e }));
    },
  };
}
