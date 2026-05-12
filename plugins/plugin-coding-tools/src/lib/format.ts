import type { ActionResult, IAgentRuntime } from "@elizaos/core";
import { type ActionResultData, FAILURE_TEXT_PREFIX, type ToolFailure } from "../types.js";

export function failureToActionResult(
  failure: ToolFailure,
  data?: Record<string, unknown>,
): ActionResult {
  const text = `${FAILURE_TEXT_PREFIX} ${failure.reason}: ${failure.message}`;
  return {
    success: false,
    text,
    error: new Error(text),
    ...(data ? { data: data as ActionResultData } : {}),
  };
}

export function successActionResult(
  text: string,
  data?: Record<string, unknown>,
): ActionResult {
  return {
    success: true,
    text,
    ...(data ? { data: data as ActionResultData } : {}),
  };
}

export function readParam<T = unknown>(options: unknown, name: string): T | undefined {
  if (!options || typeof options !== "object") return undefined;
  const opts = options as Record<string, unknown>;
  const params = opts.parameters as Record<string, unknown> | undefined;
  const value = (params?.[name] ?? opts[name]) as T | undefined;
  return value;
}

export function readStringParam(options: unknown, name: string): string | undefined {
  const v = readParam<unknown>(options, name);
  return typeof v === "string" ? v : undefined;
}

export function readNumberParam(options: unknown, name: string): number | undefined {
  const v = readParam<unknown>(options, name);
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const parsed = Number(v);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

export function readBoolParam(options: unknown, name: string): boolean | undefined {
  const v = readParam<unknown>(options, name);
  if (typeof v === "boolean") return v;
  if (v === "true" || v === "1" || v === 1) return true;
  if (v === "false" || v === "0" || v === 0) return false;
  return undefined;
}

export function readArrayParam(options: unknown, name: string): unknown[] | undefined {
  const v = readParam<unknown>(options, name);
  return Array.isArray(v) ? v : undefined;
}

export function truncate(s: string, max: number): { text: string; truncated: boolean } {
  if (s.length <= max) return { text: s, truncated: false };
  return {
    text: `${s.slice(0, max)}\n…[truncated, ${s.length - max} more chars]`,
    truncated: true,
  };
}

/** Reads a numeric runtime setting; invalid or missing falls back to `fallback`. */
export function readPositiveIntSetting(
  runtime: IAgentRuntime,
  key: string,
  fallback: number,
): number {
  const v = runtime.getSetting?.(key);
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return Math.floor(v);
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  }
  return fallback;
}
