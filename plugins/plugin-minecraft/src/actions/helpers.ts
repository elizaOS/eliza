import type {
  ActionParameters,
  ActionResult,
  Content,
  HandlerCallback,
  HandlerOptions,
  Memory,
} from "@elizaos/core";
import type { JsonValue } from "../protocol.js";
import { extractVec3, type Vec3 } from "./utils.js";

const MINECRAFT_ACTION_TIMEOUT_MS = 15_000;
const MAX_MINECRAFT_TEXT_LENGTH = 2000;
const MAX_MINECRAFT_ARRAY_ITEMS = 25;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function parseJsonObject(text: string): Record<string, unknown> {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return {};
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function readParams(
  options?: HandlerOptions | Record<string, JsonValue | undefined>
): Record<string, unknown> {
  const maybe = isRecord(options) && isRecord(options.parameters) ? options.parameters : {};
  return maybe as ActionParameters;
}

export function mergedInput(
  message: Memory,
  options?: HandlerOptions | Record<string, JsonValue | undefined>
): Record<string, unknown> {
  return {
    ...parseJsonObject(message.content.text ?? ""),
    ...readParams(options),
  };
}

export function readString(params: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = params[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

export function readNumber(params: Record<string, unknown>, ...keys: string[]): number | null {
  for (const key of keys) {
    const value = params[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim()) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

export function readBoolean(params: Record<string, unknown>, ...keys: string[]): boolean | null {
  for (const key of keys) {
    const value = params[key];
    if (typeof value === "boolean") return value;
    if (typeof value === "string") {
      const normalized = value.trim().toLowerCase();
      if (normalized === "true") return true;
      if (normalized === "false") return false;
    }
  }
  return null;
}

export function parseVec3(params: Record<string, unknown>, text: string): Vec3 | null {
  const x = readNumber(params, "x");
  const y = readNumber(params, "y");
  const z = readNumber(params, "z");
  if (x !== null && y !== null && z !== null) return { x, y, z };
  return extractVec3(text);
}

export type PlaceFace = "up" | "down" | "north" | "south" | "east" | "west";

export function isPlaceFace(value: string | null): value is PlaceFace {
  return (
    value === "up" ||
    value === "down" ||
    value === "north" ||
    value === "south" ||
    value === "east" ||
    value === "west"
  );
}

export function callbackContent(actionName: string, text: string, source: unknown): Content {
  return {
    text,
    actions: [actionName],
    source: typeof source === "string" ? source : undefined,
  };
}

export async function emit(
  actionName: string,
  callback: HandlerCallback | undefined,
  text: string,
  source: unknown,
  result: Omit<ActionResult, "text">
): Promise<ActionResult> {
  const content = callbackContent(actionName, text.slice(0, MAX_MINECRAFT_TEXT_LENGTH), source);
  await callback?.(content, actionName);
  return { text: content.text ?? text, ...result };
}

export async function withMinecraftTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out`)), MINECRAFT_ACTION_TIMEOUT_MS)
    ),
  ]);
}

export function capMinecraftData<T>(value: T): T {
  if (Array.isArray(value)) return value.slice(0, MAX_MINECRAFT_ARRAY_ITEMS) as T;
  return value;
}
