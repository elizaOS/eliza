/**
 * Minimal core runtime surface used by wallet unit tests that exercise plugin
 * wiring without loading the full `@elizaos/core` source graph. Sparse CI lanes
 * do not install every transitive core dependency, so tests import this through
 * `vi.mock("@elizaos/core", ...)` before loading wallet modules.
 */

type RuntimeCache = {
  getCache?<T>(key: string): Promise<T | undefined>;
  setCache?(key: string, value: unknown): Promise<unknown>;
  deleteCache?(key: string): Promise<unknown>;
};

export class ElizaError extends Error {
  readonly code: string;
  readonly context?: Record<string, unknown>;
  readonly severity?: "ephemeral" | "fatal";

  constructor(
    message: string,
    options: {
      code: string;
      cause?: unknown;
      context?: Record<string, unknown>;
      severity?: "ephemeral" | "fatal";
    },
  ) {
    super(
      message,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.code = options.code;
    this.context = options.context;
    this.severity = options.severity;
  }
}

export class Service {
  static serviceType = "service";

  readonly runtime: unknown;

  constructor(runtime?: unknown) {
    this.runtime = runtime;
  }

  static async start(runtime: unknown): Promise<Service> {
    return new Service(runtime);
  }

  async stop(): Promise<void> {}
}

export const ServiceType = {
  WALLET: "wallet",
  TOKEN_DATA: "token-data",
} as const;

export const ModelType = {
  TEXT_SMALL: "TEXT_SMALL",
  TEXT_LARGE: "TEXT_LARGE",
} as const;

export const logger = {
  debug: () => undefined,
  error: () => undefined,
  info: () => undefined,
  log: () => undefined,
  warn: () => undefined,
};

export const elizaLogger = logger;

export function parseBooleanFromText(value: string): boolean {
  return /^(1|true|yes|y|on)$/i.test(value.trim());
}

export function parseJSONObjectFromText(value: string): unknown {
  return JSON.parse(value);
}

export function composePromptFromState(): string {
  return "";
}

export function promoteSubactionsToActions(action: unknown): unknown[] {
  return Array.isArray(action) ? action : [action];
}

export function registerAppRoutePluginLoader(): void {}

export async function requireConfirmation(args: {
  readonly runtime: RuntimeCache;
  readonly message: { readonly entityId?: string; readonly content?: unknown };
  readonly actionName: string;
  readonly pendingKey: string;
  readonly metadata?: Record<string, unknown>;
}): Promise<{
  readonly status: "pending" | "confirmed" | "cancelled";
  readonly metadata?: Record<string, unknown>;
}> {
  const userId = String(args.message.entityId);
  const cacheKey = `confirmation:${userId}:${args.actionName}:${args.pendingKey}`;
  const existing = await args.runtime.getCache?.<{
    metadata?: Record<string, unknown>;
  }>(cacheKey);
  const text =
    typeof (args.message.content as { text?: unknown } | undefined)?.text ===
    "string"
      ? String((args.message.content as { text: string }).text).toLowerCase()
      : "";

  if (existing && /\b(yes|confirm|confirmed|approve)\b/.test(text)) {
    await args.runtime.deleteCache?.(cacheKey);
    return { status: "confirmed", metadata: existing.metadata };
  }

  if (!existing && args.metadata) {
    await args.runtime.setCache?.(cacheKey, {
      createdAt: Date.now(),
      ttlMs: 5 * 60_000,
      metadata: args.metadata,
    });
  }

  return { status: "pending" };
}
