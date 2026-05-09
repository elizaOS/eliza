import type http from "node:http";

export interface ReadJsonBodyOptions {
  maxBytes?: number;
  tooLargeMessage?: string;
  destroyOnTooLarge?: boolean;
  requireObject?: boolean;
}

export interface RouteRequestMeta {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  method: string;
  pathname: string;
}

export interface RouteHelpers {
  json: (res: http.ServerResponse, data: unknown, status?: number) => void;
  error: (res: http.ServerResponse, message: string, status?: number) => void;
  readJsonBody: <T extends object>(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    options?: ReadJsonBodyOptions,
  ) => Promise<T | null>;
}

function scrubStackFields(value: unknown): unknown {
  if (value instanceof Error) {
    return { error: value.message || "Internal error" };
  }
  if (Array.isArray(value)) {
    return value.map(scrubStackFields);
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      if (key === "stack" || key === "stackTrace") continue;
      out[key] = scrubStackFields(nested);
    }
    return out;
  }
  return value;
}

export function sendJson(
  res: http.ServerResponse,
  body: unknown,
  status = 200,
): void {
  if (res.headersSent) return;
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(scrubStackFields(body)));
}

export function sendJsonError(
  res: http.ServerResponse,
  message: string,
  status = 400,
): void {
  sendJson(res, { error: message }, status);
}

async function readRequestBody(
  req: http.IncomingMessage,
  options: ReadJsonBodyOptions,
): Promise<string | null> {
  const maxBytes = options.maxBytes ?? 1_048_576;
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of req) {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    size += buffer.length;
    if (size > maxBytes) {
      if (options.destroyOnTooLarge) req.destroy();
      throw new Error(options.tooLargeMessage ?? "Request body too large");
    }
    chunks.push(buffer);
  }

  if (chunks.length === 0) return null;
  return Buffer.concat(chunks).toString("utf8");
}

export async function readJsonBody<T extends object = Record<string, unknown>>(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  options: ReadJsonBodyOptions = {},
): Promise<T | null> {
  const cached = (req as http.IncomingMessage & { body?: unknown }).body;
  if (cached !== undefined) {
    if (
      options.requireObject !== false &&
      (!cached || typeof cached !== "object" || Array.isArray(cached))
    ) {
      sendJsonError(res, "Request body must be a JSON object", 400);
      return null;
    }
    return cached as T;
  }

  let raw: string | null;
  try {
    raw = await readRequestBody(req, options);
  } catch (error) {
    sendJsonError(
      res,
      error instanceof Error ? error.message : "Failed to read request body",
      413,
    );
    return null;
  }

  if (!raw?.trim()) {
    const empty = {} as T;
    (req as http.IncomingMessage & { body?: unknown }).body = empty;
    return empty;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    sendJsonError(res, "Invalid JSON in request body", 400);
    return null;
  }

  if (
    options.requireObject !== false &&
    (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
  ) {
    sendJsonError(res, "Request body must be a JSON object", 400);
    return null;
  }

  (req as http.IncomingMessage & { body?: unknown }).body = parsed;
  return parsed as T;
}
