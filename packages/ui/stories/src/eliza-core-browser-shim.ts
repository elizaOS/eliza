export const DEFAULT_MAX_BODY_BYTES = 1_048_576;

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
