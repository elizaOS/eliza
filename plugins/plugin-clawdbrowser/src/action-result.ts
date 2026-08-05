/**
 * elizaOS ActionResult helpers — set data.actionName for multi-step plans.
 * Runtime: options.actionContext.getPreviousResult(name) matches data.actionName.
 */

import type { ActionResult, HandlerOptions, State } from "@elizaos/core";

export function actionSuccess(
  actionName: string,
  text: string,
  data?: Record<string, unknown>,
  extra?: Partial<ActionResult>,
): ActionResult {
  return {
    success: true,
    text,
    userFacingText: text,
    data: { actionName, ...(data || {}) },
    ...extra,
  };
}

export function actionFailure(
  actionName: string,
  text: string,
  error?: unknown,
  data?: Record<string, unknown>,
): ActionResult {
  const errMsg =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : text;
  return {
    success: false,
    text,
    error: errMsg,
    data: { actionName, ...(data || {}) },
  };
}

export function getPriorActionResult(
  actionName: string,
  options?: HandlerOptions | Record<string, unknown>,
  state?: State,
): ActionResult | undefined {
  const opts = options as HandlerOptions | undefined;
  const fromCtx = opts?.actionContext?.getPreviousResult?.(actionName);
  if (fromCtx) return fromCtx;
  const prev = opts?.actionContext?.previousResults;
  if (Array.isArray(prev)) {
    const hit = [...prev]
      .reverse()
      .find((r) => r?.data?.actionName === actionName);
    if (hit) return hit;
  }
  const fromState = state?.data?.actionResults;
  if (Array.isArray(fromState)) {
    return [...fromState]
      .reverse()
      .find((r) => r?.data?.actionName === actionName);
  }
  return undefined;
}
