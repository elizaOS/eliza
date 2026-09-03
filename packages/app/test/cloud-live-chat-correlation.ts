/**
 * Reduces one successful live chat response to publishable correlation data.
 * Only validated identifiers and canonical numeric timing fields survive; URLs,
 * response bodies, arbitrary Server-Timing descriptions, and credentials do not.
 */

const TRACE_ID = /^[0-9a-f]{32}$/;
const PROVIDER_REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SERVER_TIMING_NAME = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const DECIMAL_MS = /^\d+(?:\.\d+)?$/;
const MAX_TIMING_MS = 3_600_000;
const PREFORWARD_FIELDS = ["total", "auth", "mid", "reserve", "setup"] as const;

export interface CloudLiveChatCorrelationEvidence {
  traceId: string;
  serverTiming: string;
  preforward: string | null;
  providerRequestId: string | null;
}

type ResponseHeaders = Readonly<Record<string, string | undefined>>;

function header(headers: ResponseHeaders, name: string): string | null {
  const value = headers[name.toLowerCase()]?.trim();
  return value ? value : null;
}

function canonicalDuration(raw: string): string | null {
  if (!DECIMAL_MS.test(raw)) return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > MAX_TIMING_MS)
    return null;
  return String(value);
}

/** Keep metric names and durations while dropping arbitrary description text. */
export function sanitizeServerTiming(value: string | null): string | null {
  if (!value || value.length > 4_096) return null;
  const metrics: string[] = [];
  for (const rawMetric of value.split(",")) {
    const [rawName, ...parameters] = rawMetric.split(";");
    const name = rawName?.trim() ?? "";
    if (!SERVER_TIMING_NAME.test(name)) continue;
    const durationParameters = parameters
      .map((parameter) => parameter.trim())
      .filter((parameter) => parameter.startsWith("dur="));
    if (durationParameters.length !== 1) continue;
    const duration = canonicalDuration(durationParameters[0].slice(4).trim());
    if (duration === null) continue;
    metrics.push(`${name};dur=${duration}`);
    if (metrics.length === 32) break;
  }
  return metrics.length > 0 ? metrics.join(", ") : null;
}

export function sanitizePreforward(value: string | null): string | null {
  if (!value || value.length > 256) return null;
  const fields = new Map<string, string>();
  for (const part of value.split(";")) {
    const separator = part.indexOf("=");
    if (separator <= 0) return null;
    const name = part.slice(0, separator).trim();
    const duration = canonicalDuration(part.slice(separator + 1).trim());
    if (
      !(PREFORWARD_FIELDS as readonly string[]).includes(name) ||
      duration === null ||
      fields.has(name)
    ) {
      return null;
    }
    fields.set(name, duration);
  }
  if (fields.size !== PREFORWARD_FIELDS.length) return null;
  return PREFORWARD_FIELDS.map((name) => `${name}=${fields.get(name)}`).join(
    ";",
  );
}

export function parseCloudLiveChatCorrelation(
  headers: ResponseHeaders,
): CloudLiveChatCorrelationEvidence | null {
  const traceId = header(headers, "x-eliza-trace-id");
  if (!traceId || !TRACE_ID.test(traceId)) return null;
  const serverTiming = sanitizeServerTiming(header(headers, "server-timing"));
  if (!serverTiming) return null;
  const providerRequestId = header(headers, "x-eliza-provider-request-id");
  return {
    traceId,
    serverTiming,
    preforward: sanitizePreforward(header(headers, "x-eliza-preforward-ms")),
    providerRequestId:
      providerRequestId && PROVIDER_REQUEST_ID.test(providerRequestId)
        ? providerRequestId
        : null,
  };
}

function isChatStream(method: string, rawUrl: string): boolean {
  if (method.trim().toUpperCase() !== "POST") return false;
  try {
    return /\/api\/conversations\/[^/]+\/messages\/stream$/.test(
      new URL(rawUrl).pathname.replace(/\/+$/, ""),
    );
  } catch {
    return false;
  }
}

export interface CloudLiveChatCorrelationCapture {
  observe(
    method: string,
    rawUrl: string,
    status: number,
    headers: ResponseHeaders,
  ): void;
  requireSuccessful(): CloudLiveChatCorrelationEvidence;
}

export function createCloudLiveChatCorrelationCapture(): CloudLiveChatCorrelationCapture {
  let latest: CloudLiveChatCorrelationEvidence | null = null;
  return {
    observe(method, rawUrl, status, headers) {
      if (status < 200 || status >= 300 || !isChatStream(method, rawUrl))
        return;
      latest = parseCloudLiveChatCorrelation(headers);
    },
    requireSuccessful() {
      if (!latest) {
        throw new Error(
          "[cloud-live] successful chat response lacked a valid trace correlation header",
        );
      }
      return { ...latest };
    },
  };
}
