/**
 * Fetch wrapper that rewrites AI SDK / `ollama-ai-provider-v2` `/api/chat` bodies
 * into native Ollama shape.
 *
 * `ollama-ai-provider-v2` emits OpenAI-ish top-level fields (`temperature`,
 * `top_p`, `max_output_tokens`, `tool_choice`). Stock Ollama historically expects
 * sampling under `options` (`temperature`, `top_p`, `num_predict`). Stricter
 * Ollama forks (e.g. zerollama) reject the top-level aliases with HTTP 400
 * `unknown field: …`, which breaks every chat/tool turn. This rewrite is
 * compatible with both: native fields stay under `options`, and unsupported
 * top-level `tool_choice` is dropped (tools still work without it).
 */

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function isApiChatUrl(url: string): boolean {
  try {
    const { pathname } = new URL(url);
    return pathname === "/api/chat" || pathname.endsWith("/api/chat");
  } catch {
    return /\/api\/chat(?:\?|$)/.test(url);
  }
}

/**
 * Move AI-SDK chat fields into native Ollama `options` and drop `tool_choice`.
 * Returns the same object when nothing needs rewriting.
 */
export function rewriteOllamaChatBody(body: JsonObject): JsonObject {
  const options = { ...asObject(body.options) };
  let changed = false;

  if (typeof body.temperature === "number" && options.temperature === undefined) {
    options.temperature = body.temperature;
    changed = true;
  }
  if (typeof body.top_p === "number" && options.top_p === undefined) {
    options.top_p = body.top_p;
    changed = true;
  }
  if (
    typeof body.max_output_tokens === "number" &&
    options.num_predict === undefined
  ) {
    options.num_predict = body.max_output_tokens;
    changed = true;
  }

  const next: JsonObject = { ...body };
  if ("temperature" in next) {
    delete next.temperature;
    changed = true;
  }
  if ("top_p" in next) {
    delete next.top_p;
    changed = true;
  }
  if ("max_output_tokens" in next) {
    delete next.max_output_tokens;
    changed = true;
  }
  // Zerollama rejects top-level tool_choice; Ollama tool calling still works
  // when `tools` is present without an explicit choice.
  if ("tool_choice" in next) {
    delete next.tool_choice;
    changed = true;
  }

  if (Object.keys(options).length > 0) {
    next.options = options;
  } else {
    delete next.options;
  }

  return changed ? next : body;
}

/** Wrap `fetch` so POST `/api/chat` JSON bodies use native Ollama field names. */
export function wrapOllamaNativeChatFetch(
  baseFetch: typeof fetch = fetch,
): typeof fetch {
  return (async (input, init) => {
    const url = requestUrl(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (method !== "POST" || !isApiChatUrl(url) || init?.body == null) {
      return baseFetch(input, init);
    }

    let raw: string | null = null;
    if (typeof init.body === "string") {
      raw = init.body;
    } else if (init.body instanceof Uint8Array) {
      raw = new TextDecoder().decode(init.body);
    } else if (init.body instanceof ArrayBuffer) {
      raw = new TextDecoder().decode(new Uint8Array(init.body));
    }

    if (raw == null) {
      return baseFetch(input, init);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return baseFetch(input, init);
    }

    const obj = asObject(parsed);
    if (!obj) {
      return baseFetch(input, init);
    }

    const rewritten = rewriteOllamaChatBody(obj);
    if (rewritten === obj) {
      return baseFetch(input, init);
    }

    return baseFetch(input, {
      ...init,
      body: JSON.stringify(rewritten),
    });
  }) as typeof fetch;
}

/** Prefer `runtime.fetch` when present, always wrapped for `/api/chat` compat. */
export function resolveOllamaFetch(runtime: {
  fetch?: typeof fetch;
}): typeof fetch {
  return wrapOllamaNativeChatFetch(runtime.fetch ?? fetch);
}
