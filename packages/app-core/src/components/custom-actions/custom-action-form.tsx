import type { CustomActionHandler } from "@elizaos/agent";

/* ── Types ─────────────────────────────────────────────────────────── */

export type HandlerType = "http" | "shell" | "code";
export type HttpMethod = "GET" | "POST" | "PUT" | "DELETE" | "PATCH";

export interface ParamDef {
  name: string;
  description: string;
  required: boolean;
}

export interface HeaderRow {
  key: string;
  value: string;
}

export interface ParsedGeneration {
  name: string;
  description: string;
  handlerType: HandlerType;
  handler: CustomActionHandler;
  parameters: ParamDef[];
  similes: string[];
  enabled: boolean;
}

/* ── Constants ─────────────────────────────────────────────────────── */

export const HTTP_METHODS = ["GET", "POST", "PUT", "DELETE", "PATCH"] as const;
const METHODS_SET = new Set<string>(HTTP_METHODS);

/* ── CSS class names ───────────────────────────────────────────────── */

export const editorDialogContentClassName =
  "w-[min(calc(100%_-_2rem),48rem)] max-h-[min(90vh,56rem)] overflow-hidden rounded-2xl border border-border/70 bg-card/96 p-0 shadow-2xl backdrop-blur-xl";
export const editorFieldLabelClassName = "text-xs text-muted";
export const editorInputClassName =
  "rounded-xl border-border bg-surface text-txt placeholder:text-muted/50 focus-visible:ring-accent/25";
export const editorTextareaClassName = `${editorInputClassName} resize-none`;
export const editorMonoTextareaClassName = `${editorTextareaClassName} font-mono`;
export const editorSectionCardClassName =
  "flex flex-col gap-3 rounded-xl border border-border/70 bg-bg/20 p-3";

/* ── Normalization helpers ─────────────────────────────────────────── */

export function toNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

export function normalizeActionName(value: string): string {
  const safe = value.length > 256 ? value.slice(0, 256) : value;
  return safe
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export function normalizeAlias(value: string): string {
  return normalizeActionName(value);
}

export function normalizeParamName(value: string): string {
  return value
    .trim()
    .replace(/[^A-Za-z0-9_]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export function normalizeMethod(value: unknown): HttpMethod {
  const method = toNonEmptyString(value)?.toUpperCase();
  return method && METHODS_SET.has(method) ? (method as HttpMethod) : "GET";
}

/* ── Parsing helpers ───────────────────────────────────────────────── */

export function parseHeaders(value: unknown): HeaderRow[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [];
  }
  return Object.entries(value).flatMap(([key, rawValue]) => {
    const trimmedKey = normalizeParamName(key);
    if (!trimmedKey) return [];
    if (typeof rawValue !== "string") return [];
    return [{ key: key.trim(), value: rawValue }];
  });
}

export function parseParameters(value: unknown): ParamDef[] {
  if (!Array.isArray(value)) return [];

  const seen = new Set<string>();

  return value
    .map((raw) => {
      if (!raw || typeof raw !== "object") return null;

      const candidate = raw as {
        name?: unknown;
        description?: unknown;
        required?: unknown;
      };

      const rawName = toNonEmptyString(candidate.name);
      if (!rawName) return null;

      const name = normalizeParamName(rawName);
      if (!name || seen.has(name.toLowerCase())) return null;
      seen.add(name.toLowerCase());

      return {
        name,
        description: toNonEmptyString(candidate.description) || name,
        required: candidate.required === true,
      } satisfies ParamDef;
    })
    .filter((param): param is ParamDef => param !== null);
}

export function parseSimiles(value: unknown): string[] {
  if (!Array.isArray(value)) return [];

  const seen = new Set<string>();

  return value
    .map((raw) => toNonEmptyString(raw) || "")
    .map((simile) => normalizeAlias(simile))
    .filter((simile) => simile.length > 0)
    .filter((simile) => {
      const key = simile.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

export function parseGeneratedAction(payload: unknown): {
  ok: boolean;
  action?: ParsedGeneration;
  errors: string[];
} {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, errors: ["Generation returned an invalid payload."] };
  }

  const raw = payload as Record<string, unknown>;

  const name = normalizeActionName(raw.name?.toString() ?? "");
  const description = toNonEmptyString(raw.description) ?? "";

  if (!name) {
    return {
      ok: false,
      errors: ["Generated action must include a name."],
    };
  }

  const handlerSource = raw.handler;
  if (
    !handlerSource ||
    typeof handlerSource !== "object" ||
    Array.isArray(handlerSource)
  ) {
    return {
      ok: false,
      errors: ["Generated action must include a handler block."],
    };
  }

  const hTypeRaw =
    toNonEmptyString((raw as { handlerType?: unknown }).handlerType) ??
    toNonEmptyString((handlerSource as { type?: unknown }).type);
  const handlerType = hTypeRaw?.toLowerCase() as HandlerType | undefined;

  if (
    handlerType !== "http" &&
    handlerType !== "shell" &&
    handlerType !== "code"
  ) {
    return {
      ok: false,
      errors: ["Generated handler type must be http, shell, or code."],
    };
  }

  const params = parseParameters(raw.parameters);

  if (handlerType === "http") {
    const rawHttp = handlerSource as {
      method?: unknown;
      url?: unknown;
      headers?: unknown;
      bodyTemplate?: unknown;
      methodType?: unknown;
      type?: unknown;
    };

    const url = toNonEmptyString(rawHttp.url);
    if (!url) {
      return {
        ok: false,
        errors: ["HTTP action requires a URL."],
      };
    }

    const handler: CustomActionHandler = {
      type: "http",
      method: normalizeMethod(rawHttp.method ?? rawHttp.methodType),
      url,
      headers: parseHeaders(rawHttp.headers).length
        ? parseHeaders(rawHttp.headers).reduce<Record<string, string>>(
            (acc, item) => {
              if (item.key) {
                acc[item.key] = item.value;
              }
              return acc;
            },
            {},
          )
        : undefined,
      bodyTemplate: toNonEmptyString(rawHttp.bodyTemplate),
    };

    return {
      ok: true,
      action: {
        name,
        description,
        handlerType,
        handler,
        parameters: params,
        similes: parseSimiles(raw.similes),
        enabled: raw.enabled === true,
      },
      errors: [],
    };
  }

  if (handlerType === "shell") {
    const rawShell = handlerSource as {
      command?: unknown;
    };

    const command = toNonEmptyString(rawShell.command);
    if (!command) {
      return {
        ok: false,
        errors: ["Shell action requires a command template."],
      };
    }

    return {
      ok: true,
      action: {
        name,
        description,
        handlerType,
        handler: {
          type: "shell",
          command,
        },
        parameters: params,
        similes: parseSimiles(raw.similes),
        enabled: raw.enabled === true,
      },
      errors: [],
    };
  }

  const rawCode = handlerSource as {
    code?: unknown;
    source?: unknown;
  };
  const code =
    toNonEmptyString(rawCode.code) ?? toNonEmptyString(rawCode.source);

  if (!code) {
    return {
      ok: false,
      errors: ["Code action requires a JavaScript code block."],
    };
  }

  return {
    ok: true,
    action: {
      name,
      description,
      handlerType,
      handler: {
        type: "code",
        code,
      },
      parameters: params,
      similes: parseSimiles(raw.similes),
      enabled: raw.enabled === true,
    },
    errors: [],
  };
}

export function parseSimilesInput(value: string): string[] {
  return value
    .split(",")
    .map((raw) => normalizeAlias(raw))
    .filter(Boolean);
}

export function validateParameters(items: ParamDef[]): string | null {
  const seen = new Set<string>();

  for (const parameter of items) {
    const normalized = normalizeParamName(parameter.name);
    if (!normalized) {
      return "Each parameter needs a non-empty name.";
    }

    if (seen.has(normalized.toLowerCase())) {
      return `Duplicate parameter name: ${normalized}`;
    }

    seen.add(normalized.toLowerCase());
    parameter.name = normalized;
  }

  return null;
}
