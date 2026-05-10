import os from "node:os";
import path from "node:path";

export class DatabaseSync {}

export async function hasOwnerAccess(): Promise<boolean> {
  return true;
}

export async function extractActionParamsViaLlm(): Promise<unknown> {
  return null;
}

export function renderGroundedActionReply(args?: { text?: string }): string {
  return args?.text ?? "";
}

export function createIntegrationTelemetrySpan() {
  return {
    end: () => undefined,
    recordException: () => undefined,
    setAttribute: () => undefined,
    setStatus: () => undefined,
  };
}

export function extractConversationMetadataFromRoom(): Record<string, unknown> {
  return {};
}

export function isPageScopedConversationMetadata(): boolean {
  return false;
}

export function computeNextCronRunAtMs(): number {
  return Date.now() + 60_000;
}

export function parseCronExpression(expression: string): { expression: string } {
  return { expression };
}

export function registerEscalationChannel(): void {}

export function getAgentEventService(): null {
  return null;
}

export function resolveOwnerEntityId(runtime?: { agentId?: string }): string {
  return runtime?.agentId ?? "owner-1";
}

export function resolveStateDir(): string {
  return path.join(os.tmpdir(), "eliza-lifeops-test-state");
}

export function resolveOAuthDir(): string {
  return path.join(os.tmpdir(), "eliza-lifeops-test-oauth");
}

export function resolveDefaultAgentWorkspaceDir(): string {
  return path.join(os.tmpdir(), "eliza-lifeops-test-workspace");
}

export function loadElizaConfig(): Record<string, unknown> {
  return {};
}

export function saveElizaConfig(): void {}

export function createElizaPlugin(plugin: unknown): unknown {
  return plugin;
}

export async function startApiServer(): Promise<{ close: () => Promise<void> }> {
  return { close: async () => undefined };
}

export async function handleConnectorAccountRoutes(args: {
  pathname: string;
  error: (res: unknown, message: string, status?: number) => void;
  res: unknown;
}): Promise<boolean> {
  if (args.pathname.endsWith("/oauth/callback")) {
    args.error(args.res, "Missing OAuth state", 400);
    return true;
  }
  return false;
}
