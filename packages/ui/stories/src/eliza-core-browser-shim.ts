/**
 * Browser shim standing in for @elizaos/core in the stories app: the minimal types/constants the gallery needs without pulling the runtime.
 */
export const DEFAULT_MAX_BODY_BYTES = 1_048_576;

// Mirrors core's canonical truthy set (core/src/env-utils.ts); re-exported
// through @elizaos/shared/env-utils, which gallery pages reach via
// runtime-env — without it any page importing shared env helpers throws.
const TRUTHY_ENV_VALUES = new Set(["1", "true", "yes", "y", "on", "enabled"]);
// Browser-safe stand-ins for the core env/error helpers the shared package
// re-exports. The gallery has no process env or boot config, so alias
// resolution degrades to a direct lookup and errors format to their message.
export function resolveAliasedEnvValue(
  key: string,
  _aliases?: readonly (readonly [string, string])[],
  env: Record<string, string | undefined> | null = null,
): string | undefined {
  const value = env?.[key];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

// Mirrors core's throw-proof contract (utils/format-error.ts): this runs on
// error paths, so it must never itself throw or return a non-string.
export function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return String(error);
  }
}

// Deterministic, dependency-free stand-in for core's stringToUuid — the
// gallery only needs stable, well-formed ids, not the runtime's exact hash.
export function stringToUuid(target: string): string {
  let h = 0;
  for (let i = 0; i < target.length; i++) {
    h = (h * 31 + target.charCodeAt(i)) >>> 0;
  }
  const hex = h.toString(16).padStart(8, "0");
  return `${hex}-0000-4000-8000-${hex}${hex.slice(0, 4)}`;
}
export function isTruthyEnvValue(value: string | undefined | null): boolean {
  if (typeof value !== "string") return false;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return false;
  return TRUTHY_ENV_VALUES.has(normalized);
}

export type UUID = string;
export type TrajectoryExportFormat = "json" | "jsonl" | "markdown";
export type TriggerType = string;
export type TriggerKind = string;
export type TriggerLastStatus = string;
export type TriggerWakeMode = string;
export interface TriggerConfig {
  [key: string]: unknown;
}
export interface TriggerRunRecord {
  [key: string]: unknown;
}
export interface ReadJsonBodyOptions {
  [key: string]: unknown;
}
export interface RequestBodyOptions {
  [key: string]: unknown;
}
export interface RouteRequestMeta {
  [key: string]: unknown;
}
export interface RouteHelpers {
  [key: string]: unknown;
}
export interface RouteRequestContext extends RouteRequestMeta, RouteHelpers {}
export interface AppPackageRouteContext extends RouteRequestMeta {
  [key: string]: unknown;
}
export interface AppPackageRouteDispatchContext extends RouteRequestContext {
  [key: string]: unknown;
}

export type BlockStreamingChunkConfig = Record<string, unknown>;
export type BlockStreamingCoalesceConfig = Record<string, unknown>;
export type HumanDelayConfig = Record<string, unknown>;
export type TypingMode = string;
export type PluginAutoEnableContext = Record<string, unknown>;
export type PluginAutoEnableModule = Record<string, unknown>;
export type RolesConfig = Record<string, unknown>;
export type SessionConfig = Record<string, unknown>;
export type SessionSendPolicyConfig = Record<string, unknown>;
export type AgentElevatedAllowFromConfig = Record<string, unknown>;
export type NormalizedChatType = string;
export type SessionSendPolicyAction = string;
export type ToolPolicyConfig = Record<string, unknown>;
export type ToolProfileId = string;
export type GroupChatConfig = Record<string, unknown>;
export type IdentityConfig = Record<string, unknown>;
export type Memory = Record<string, unknown>;
export type State = Record<string, unknown>;
export type Content = Record<string, unknown>;
export type MessageExampleGroup = Array<Record<string, unknown>>;
export type IAgentRuntime = Record<string, unknown>;
export type AgentRuntime = Record<string, unknown>;
export type PluginWidgetDeclaration = Record<string, unknown>;

export const ModelType = {
  NANO: "TEXT_NANO",
  SMALL: "TEXT_SMALL",
  MEDIUM: "TEXT_MEDIUM",
  LARGE: "TEXT_LARGE",
  MEGA: "TEXT_MEGA",
  TEXT_NANO: "TEXT_NANO",
  TEXT_SMALL: "TEXT_SMALL",
  TEXT_MEDIUM: "TEXT_MEDIUM",
  TEXT_LARGE: "TEXT_LARGE",
  TEXT_MEGA: "TEXT_MEGA",
  RESPONSE_HANDLER: "RESPONSE_HANDLER",
  ACTION_PLANNER: "ACTION_PLANNER",
  TEXT_EMBEDDING: "TEXT_EMBEDDING",
  TEXT_TOKENIZER_ENCODE: "TEXT_TOKENIZER_ENCODE",
  TEXT_TOKENIZER_DECODE: "TEXT_TOKENIZER_DECODE",
  TEXT_REASONING_SMALL: "REASONING_SMALL",
  TEXT_REASONING_LARGE: "REASONING_LARGE",
  TEXT_COMPLETION: "TEXT_COMPLETION",
  IMAGE: "IMAGE",
  IMAGE_DESCRIPTION: "IMAGE_DESCRIPTION",
  TRANSCRIPTION: "TRANSCRIPTION",
  TEXT_TO_SPEECH: "TEXT_TO_SPEECH",
  AUDIO: "AUDIO",
  VIDEO: "VIDEO",
  RESEARCH: "RESEARCH",
} as const;

export type ModelTypeName = (typeof ModelType)[keyof typeof ModelType] | string;

const noopLogger = (): void => undefined;

export const logger = {
  trace: noopLogger,
  debug: noopLogger,
  info: noopLogger,
  warn: noopLogger,
  error: noopLogger,
  fatal: noopLogger,
  child: () => logger,
};

const MODEL_CODE_FENCE_PATTERN =
  /^\s*```(?:json|json5)?\s*\r?\n?([\s\S]*?)\r?\n?```\s*$/i;

function stripModelWrappers(raw: string): string {
  let candidate = raw.trim();
  const thinkEnd = candidate.indexOf("</think>");
  if (candidate.startsWith("<think>") && thinkEnd !== -1) {
    candidate = candidate.slice(thinkEnd + "</think>".length).trim();
  }
  const fenced = candidate.match(MODEL_CODE_FENCE_PATTERN);
  if (fenced) {
    candidate = (fenced[1] ?? "").trim();
  }
  return candidate;
}

export function parseJsonModelOutput(raw: string): unknown | null {
  const candidate = stripModelWrappers(raw);
  if (!candidate) return null;
  try {
    return JSON.parse(candidate) as unknown;
  } catch {
    return null;
  }
}

export function parseJsonModelRecord<
  T extends Record<string, unknown> = Record<string, unknown>,
>(raw: string): T | null {
  const parsed = parseJsonModelOutput(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  return parsed as T;
}

export function parseJsonModelArray<T = unknown>(raw: string): T[] | null {
  const parsed = parseJsonModelOutput(raw);
  return Array.isArray(parsed) ? (parsed as T[]) : null;
}

function readBrowserEnv(
  env: Record<string, string | undefined> | undefined,
  key: string,
): string | undefined {
  const value = env?.[key]?.trim();
  return value ? value : undefined;
}

export function getElizaNamespace(
  env: Record<string, string | undefined> = (
    globalThis as { process?: { env?: Record<string, string | undefined> } }
  ).process?.env ?? {},
): string {
  return readBrowserEnv(env, "ELIZA_NAMESPACE") ?? "eliza";
}

export function resolveUserPath(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return trimmed;
  if (trimmed.startsWith("~/")) return `/${trimmed.slice(2)}`;
  return trimmed;
}

export function resolveStateDir(
  env: Record<string, string | undefined> = (
    globalThis as { process?: { env?: Record<string, string | undefined> } }
  ).process?.env ?? {},
): string {
  const explicit = readBrowserEnv(env, "ELIZA_STATE_DIR");
  if (explicit) return explicit;
  const namespace = getElizaNamespace(env);
  const xdgStateHome = readBrowserEnv(env, "XDG_STATE_HOME");
  return `${xdgStateHome ?? "/.local/state"}/${namespace}`;
}

export async function readRequestBodyBuffer(): Promise<Buffer | null> {
  return null;
}

export async function readRequestBody(): Promise<string | null> {
  return null;
}

export async function readJsonBody<T extends object>(): Promise<T | null> {
  return null;
}

export function sendJson(): void {}

export function sendJsonError(): void {}

export function isConnectorConfigured(): boolean {
  return false;
}

export function isStreamingDestinationConfigured(): boolean {
  return false;
}

export function isWechatConfigured(): boolean {
  return false;
}

// Role-gate primitives (browser-safe, pure) so role-gated stories such as
// RoleGate.stories.tsx can render. Mirrors the canonical rank in
// @elizaos/core (roles.ts CANONICAL_ROLE_RANK + runtime/context-gates).
export type RoleGateRole =
  | "OWNER"
  | "ADMIN"
  | "MEMBER"
  | "USER"
  | "GUEST"
  | "NONE";

const CANONICAL_ROLE_RANK: Record<string, number> = {
  NONE: 0,
  GUEST: 1,
  USER: 2,
  MEMBER: 2,
  ADMIN: 3,
  OWNER: 4,
};

function normalizeGateRole(role: RoleGateRole): RoleGateRole {
  const n = String(role).trim().toUpperCase();
  return (n === "USER" ? "MEMBER" : n) as RoleGateRole;
}

export function roleRank(role: RoleGateRole): number {
  return CANONICAL_ROLE_RANK[String(normalizeGateRole(role))] ?? 0;
}

export function satisfiesRoleGate(
  userRoles: readonly RoleGateRole[] | undefined,
  gate:
    | {
        roles?: RoleGateRole[];
        anyOf?: RoleGateRole[];
        allOf?: RoleGateRole[];
        noneOf?: RoleGateRole[];
        minRole?: RoleGateRole;
      }
    | undefined,
): boolean {
  if (!gate) return true;
  const normalized = new Set((userRoles ?? []).map(normalizeGateRole));
  const highestRank = Math.max(0, ...[...normalized].map((r) => roleRank(r)));
  for (const role of gate.noneOf ?? []) {
    if (normalized.has(normalizeGateRole(role))) return false;
  }
  if (gate.minRole && highestRank < roleRank(gate.minRole)) return false;
  const anyOf = gate.anyOf ?? gate.roles;
  if (anyOf && !anyOf.some((r) => normalized.has(normalizeGateRole(r)))) {
    return false;
  }
  for (const role of gate.allOf ?? []) {
    if (!normalized.has(normalizeGateRole(role))) return false;
  }
  return true;
}
