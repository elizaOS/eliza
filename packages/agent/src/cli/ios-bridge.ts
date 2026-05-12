import process from "node:process";
import readline from "node:readline";

interface BridgeRequest {
  id?: unknown;
  method?: unknown;
  payload?: unknown;
}

interface BridgeResponse {
  id: unknown;
  ok: boolean;
  result?: unknown;
  error?: string;
}

interface HttpRequestPayload {
  method?: unknown;
  path?: unknown;
  headers?: unknown;
  body?: unknown;
  timeoutMs?: unknown;
}

interface IosBridgeBackend {
  port: number;
  close: () => Promise<void>;
}

function normalizeHeaderRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw === "string") out[key] = raw;
    else if (typeof raw === "number" || typeof raw === "boolean") {
      out[key] = String(raw);
    }
  }
  return out;
}

function isSafeLocalPath(path: string): boolean {
  return (
    path.startsWith("/") &&
    !path.startsWith("//") &&
    !/^[a-zA-Z][a-zA-Z\d+.-]*:\/\//.test(path)
  );
}

function normalizeMethod(value: unknown): string {
  const method = (typeof value === "string" ? value : "GET")
    .trim()
    .toUpperCase();
  if (!/^[A-Z]{1,16}$/.test(method)) {
    throw new Error("Unsupported HTTP method");
  }
  return method;
}

function bodyToString(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (typeof value === "string") return value;
  if (value instanceof Uint8Array) return Buffer.from(value).toString("utf8");
  return JSON.stringify(value);
}

function responseHeadersToRecord(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

async function startIosBridgeBackend(): Promise<IosBridgeBackend> {
  process.env.ELIZA_PLATFORM = process.env.ELIZA_PLATFORM || "ios";
  process.env.ELIZA_MOBILE_PLATFORM =
    process.env.ELIZA_MOBILE_PLATFORM || "ios";
  process.env.ELIZA_IOS_LOCAL_BACKEND =
    process.env.ELIZA_IOS_LOCAL_BACKEND || "1";
  process.env.ELIZA_HEADLESS = process.env.ELIZA_HEADLESS || "1";
  process.env.ELIZA_API_BIND = process.env.ELIZA_API_BIND || "127.0.0.1";
  process.env.LOG_LEVEL = process.env.LOG_LEVEL || "error";

  const { bootElizaRuntime } = await import("../runtime/index.ts");
  const { startApiServer } = await import("../api/server.ts");

  const runtime = await bootElizaRuntime();
  const server = await startApiServer({
    port: 0,
    runtime,
    skipDeferredStartupWork: true,
  });

  return {
    port: server.port,
    close: server.close,
  };
}

async function fetchBackend(
  backend: IosBridgeBackend,
  payload: HttpRequestPayload,
): Promise<{
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
}> {
  const rawPath = typeof payload.path === "string" ? payload.path.trim() : "";
  if (!rawPath || !isSafeLocalPath(rawPath)) {
    throw new Error(
      "iOS bridge http_request requires a path that starts with / and is not an absolute URL",
    );
  }

  const method = normalizeMethod(payload.method);
  const headers = normalizeHeaderRecord(payload.headers);
  const timeoutMs =
    typeof payload.timeoutMs === "number" && payload.timeoutMs > 0
      ? Math.min(payload.timeoutMs, 30 * 60_000)
      : undefined;
  const controller = timeoutMs ? new AbortController() : null;
  const timeout = controller
    ? setTimeout(() => controller.abort(), timeoutMs)
    : null;

  try {
    const response = await fetch(`http://127.0.0.1:${backend.port}${rawPath}`, {
      method,
      headers,
      body:
        method === "GET" || method === "HEAD"
          ? undefined
          : bodyToString(payload.body),
      signal: controller?.signal,
    });
    return {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeadersToRecord(response.headers),
      body: await response.text(),
    };
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function parseJsonBody(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

async function sendMessage(
  backend: IosBridgeBackend,
  payload: unknown,
): Promise<Record<string, unknown>> {
  const input =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : {};
  const message = typeof input.message === "string" ? input.message : "";
  if (!message.trim()) throw new Error("send_message requires message");

  let conversationId =
    typeof input.conversationId === "string" && input.conversationId.trim()
      ? input.conversationId.trim()
      : "";

  if (!conversationId) {
    const created = await fetchBackend(backend, {
      method: "POST",
      path: "/api/conversations",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({ title: "iOS Local Chat" }),
    });
    if (created.status < 200 || created.status >= 300) {
      throw new Error(`Failed to create conversation: HTTP ${created.status}`);
    }
    const parsed = parseJsonBody(created.body) as {
      conversation?: { id?: unknown };
    } | null;
    const id = parsed?.conversation?.id;
    if (typeof id !== "string" || !id) {
      throw new Error("Conversation create response did not include an id");
    }
    conversationId = id;
  }

  const response = await fetchBackend(backend, {
    method: "POST",
    path: `/api/conversations/${encodeURIComponent(conversationId)}/messages`,
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      text: message,
      channelType:
        typeof input.channelType === "string" ? input.channelType : "DM",
      source: "ios-local",
      ...(input.metadata &&
      typeof input.metadata === "object" &&
      !Array.isArray(input.metadata)
        ? { metadata: input.metadata }
        : {}),
    }),
  });
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`send_message failed: HTTP ${response.status}`);
  }
  const parsed = parseJsonBody(response.body) as Record<string, unknown> | null;
  const text = typeof parsed?.text === "string" ? parsed.text : "";
  return {
    reply: text,
    text,
    conversationId,
    response: parsed ?? { body: response.body },
  };
}

async function dispatchBridgeRequest(
  backend: IosBridgeBackend,
  request: BridgeRequest,
): Promise<unknown> {
  const method = typeof request.method === "string" ? request.method : "";
  switch (method) {
    case "status":
      return { ready: true, apiPort: backend.port };
    case "http_request":
    case "http_fetch":
      return fetchBackend(
        backend,
        (request.payload ?? {}) as HttpRequestPayload,
      );
    case "send_message":
      return sendMessage(backend, request.payload);
    default:
      throw new Error(`Unknown iOS bridge method: ${method || "(missing)"}`);
  }
}

function writeBridgeResponse(response: BridgeResponse): void {
  process.stdout.write(`${JSON.stringify(response)}\n`);
}

export async function runIosBridgeCli(
  argv: string[] = process.argv,
): Promise<void> {
  if (!argv.includes("--stdio")) {
    throw new Error("ios-bridge currently supports --stdio only");
  }

  const backend = await startIosBridgeBackend();
  const lines = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
    terminal: false,
  });

  const shutdown = async () => {
    try {
      await backend.close();
    } catch {
      // Best effort during app shutdown.
    }
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  for await (const line of lines) {
    if (!line.trim()) continue;
    let parsed: BridgeRequest;
    try {
      parsed = JSON.parse(line) as BridgeRequest;
    } catch (err) {
      writeBridgeResponse({
        id: null,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    const id = parsed.id ?? null;
    try {
      const result = await dispatchBridgeRequest(backend, parsed);
      writeBridgeResponse({ id, ok: true, result });
    } catch (err) {
      writeBridgeResponse({
        id,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  await shutdown();
}
