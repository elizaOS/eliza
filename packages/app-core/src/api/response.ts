import type http from "node:http";

function scrubStackFields(value: unknown): unknown {
  if (value instanceof Error) {
    return { error: value.message || "Internal error" };
  }
  if (Array.isArray(value)) {
    return value.map(scrubStackFields);
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(
      value as Record<string, unknown>,
    )) {
      if (key === "stack" || key === "stackTrace") continue;
      out[key] = scrubStackFields(nested);
    }
    return out;
  }
  return value;
}

export function sendJson(
  res: http.ServerResponse,
  status: number,
  body: unknown,
): void {
  if (res.headersSent) return;
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(scrubStackFields(body)));
}

export function sendJsonError(
  res: http.ServerResponse,
  status: number,
  message: string,
): void {
  sendJson(res, status, { error: message });
}
