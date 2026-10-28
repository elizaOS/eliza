import type { PlannerToolResult } from "@elizaos/core";

/**
 * Structured machine effect parsed from a tool result's receipt `text` — the
 * shape actions emit as an internal-visibility JSON receipt when the effect
 * has already been applied out-of-band (plugin-app-control's
 * `view_navigation`: `{"effect","status","viewId","label",...}`). `effect`
 * and `status` are the family contract; `label` is the optional human name of
 * the affected thing.
 */
export interface StructuredToolEffect {
  effect: string;
  status: string;
  label?: string;
  viewId?: string;
  resolvedAlias?: string;
}

export function structuredEffectFromToolResult(
  result: PlannerToolResult,
): StructuredToolEffect | undefined {
  const raw = result.text?.trim();
  if (!raw?.startsWith("{")) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // error-policy:J3 a tool's diagnostic text is untrusted input for this
    // projection; non-JSON text is explicitly "no structured effect" —
    // never a fake-valid effect — and the caller keeps its fallback.
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return undefined;
  }
  const { effect, status, label, viewId, resolvedAlias } = parsed as {
    effect?: unknown;
    status?: unknown;
    label?: unknown;
    viewId?: unknown;
    resolvedAlias?: unknown;
  };
  if (typeof effect !== "string" || effect.trim().length === 0) {
    return undefined;
  }
  if (typeof status !== "string" || status.trim().length === 0) {
    return undefined;
  }
  return {
    effect: effect.trim(),
    status: status.trim(),
    ...(typeof label === "string" && label.trim().length > 0
      ? { label: label.trim() }
      : {}),
    ...(effect.trim() === "view_navigation" &&
    typeof resolvedAlias === "string" &&
    resolvedAlias.trim()
      ? { resolvedAlias: resolvedAlias.trim() }
      : {}),
    ...(effect.trim() === "view_navigation" &&
    typeof viewId === "string" &&
    viewId.trim().length > 0
      ? { viewId: viewId.trim() }
      : {}),
  };
}

export function replyNamesStructuredEffectDestination(
  reply: string,
  effect: StructuredToolEffect,
): boolean {
  if (effect.effect !== "view_navigation" || !effect.label) return true;
  const normalize = (value: string): string =>
    value
      .toLocaleLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim();
  const normalizedReply = normalize(reply);
  const normalizedLabel = normalize(effect.label);
  return (
    normalizedReply.length > 0 &&
    ((normalizedLabel.length > 0 &&
      normalizedReply.includes(normalizedLabel)) ||
      // An alias is evidence only when the navigation executor resolved it
      // to this registered destination, not a guessed synonym in the reply.
      (!!effect.resolvedAlias &&
        ` ${normalizedReply} `.includes(
          ` ${normalize(effect.resolvedAlias)} `,
        )) ||
      // A delivered view has a canonical identity as well as its display
      // label (for example chat / Home). Use only that receipt's identity,
      // not guessed aliases or request text, and match complete words.
      (effect.status === "delivered" &&
        !!effect.viewId &&
        normalize(effect.viewId).length > 0 &&
        ` ${normalizedReply} `.includes(` ${normalize(effect.viewId)} `)))
  );
}
