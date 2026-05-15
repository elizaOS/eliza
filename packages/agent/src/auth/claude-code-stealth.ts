import { logger } from "@elizaos/core";

const STEALTH_GUARD = Symbol.for("eliza.claudeCodeStealthInstalled");
const CLAUDE_CODE_VERSION = "2.1.92";
const CLAUDE_CODE_SYSTEM_PREFIX =
  "You are Claude Code, Anthropic's official CLI for Claude.";
const ANTHROPIC_BETA =
  "claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,context-management-2025-06-27,prompt-caching-scope-2026-01-05,advanced-tool-use-2025-11-20,effort-2025-11-24";

type FetchWithPreconnect = typeof fetch & { preconnect?: () => void };
type FetchInput = Parameters<typeof fetch>[0];

function isSetupToken(value: string | null): value is string {
  return typeof value === "string" && value.startsWith("sk-ant-oat");
}

function getUrl(input: FetchInput | URL): URL | null {
  try {
    if (typeof input === "string") {
      return new URL(input);
    }
    if (input instanceof URL) {
      return input;
    }
    return new URL(input.url);
  } catch {
    return null;
  }
}

type AnthropicSystemBlock = { type?: string; text?: string };
type AnthropicRequestBody = {
  model?: string;
  system?: string | AnthropicSystemBlock[];
  [key: string]: unknown;
};

function addSystemPrefix(body: AnthropicRequestBody): AnthropicRequestBody {
  const prefix: AnthropicSystemBlock = {
    type: "text",
    text: CLAUDE_CODE_SYSTEM_PREFIX,
  };

  if (Array.isArray(body.system)) {
    const hasPrefix = body.system.some((block) =>
      block?.text?.startsWith("You are Claude Code"),
    );
    if (!hasPrefix) {
      body.system.unshift(prefix);
    }
  } else if (typeof body.system === "string") {
    body.system = [prefix, { type: "text", text: body.system }];
  } else {
    body.system = [prefix];
  }

  return body;
}

export function installClaudeCodeStealthFetchInterceptor(): void {
  if ((globalThis as Record<symbol, boolean>)[STEALTH_GUARD]) {
    return;
  }

  const originalFetch = globalThis.fetch.bind(globalThis);

  const stealthFetch = async function stealthFetch(
    input: FetchInput | URL,
    init?: RequestInit,
  ) {
    const url = getUrl(input);
    if (!url || url.hostname !== "api.anthropic.com") {
      return originalFetch(input, init);
    }

    const request = input instanceof Request ? input : null;
    const headers = new Headers(init?.headers ?? request?.headers ?? undefined);
    const apiKey = headers.get("x-api-key");
    const authHeader = headers.get("authorization");
    const bearerToken = authHeader?.startsWith("Bearer ")
      ? authHeader.slice(7)
      : null;

    const setupToken = isSetupToken(apiKey)
      ? apiKey
      : isSetupToken(bearerToken)
        ? bearerToken
        : null;

    if (!setupToken) {
      return originalFetch(input, init);
    }

    // Add beta=true query param so the API serves the latest model versions
    // (matches what claude-cli does, required for opus access).
    if (!url.searchParams.has("beta")) {
      url.searchParams.set("beta", "true");
    }

    headers.delete("x-api-key");
    headers.set("authorization", `Bearer ${setupToken}`);
    headers.set("anthropic-beta", ANTHROPIC_BETA);
    headers.set(
      "user-agent",
      `claude-cli/${CLAUDE_CODE_VERSION} (external, cli)`,
    );
    headers.set("x-app", "cli");

    let body = init?.body ?? request?.body;

    if (typeof body === "string") {
      try {
        const parsed = JSON.parse(body) as AnthropicRequestBody;
        body = JSON.stringify(addSystemPrefix(parsed));
      } catch {
        logger.debug(
          "[stealth] Anthropic request body was not JSON; skipping system prefix",
        );
      }
    }

    const nextInit: RequestInit = {
      ...init,
      headers,
      body: init ? body : undefined,
    };

    if (request && !init) {
      const nextRequest = new Request(url.toString(), {
        method: request.method,
        headers,
        body: typeof body === "string" ? body : undefined,
      });
      return originalFetch(nextRequest);
    }

    if (process.env.ELIZA_STEALTH_DEBUG && typeof body === "string") {
      const modelMatch = body.match(/"model":"([^"]+)"/);
      if (modelMatch) {
        logger.debug(`[stealth] anthropic model=${modelMatch[1]}`);
      }
    }
    return originalFetch(url.toString(), nextInit);
  };

  const sourceFetch = globalThis.fetch as FetchWithPreconnect;
  if ("preconnect" in sourceFetch) {
    (stealthFetch as FetchWithPreconnect).preconnect = sourceFetch.preconnect;
  }

  globalThis.fetch = stealthFetch as typeof globalThis.fetch;

  (globalThis as Record<symbol, boolean>)[STEALTH_GUARD] = true;
}
