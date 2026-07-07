/**
 * Web/Electrobun bridge surface for the `Agent` Capacitor plugin: implements
 * `AgentPlugin` over HTTP against the API server, used whenever no native
 * iOS/Android implementation is registered (see `index.ts`).
 */
import { WebPlugin } from "@capacitor/core";
import type {
  AgentPlugin,
  AgentRequestOptions,
  AgentRequestResult,
  AgentStartOptions,
  AgentStatus,
  ChatResult,
  LocalAgentTokenResult,
} from "./definitions";

interface ElizaWindow extends Window {
  /**
   * The renderer's boot-config mirror — the single source of truth for the API
   * base (see packages/ui/src/config/boot-config-store.ts). The host UI, the
   * agent static-file server, and the Electrobun renderer all write the API base
   * here; this web shim reads it rather than a bespoke API-base window global so
   * there is one base value across the app and its native plugins.
   */
  __ELIZAOS_APP_BOOT_CONFIG__?: { apiBase?: string };
  __ELIZA_API_TOKEN__?: string;
}

function readConfiguredApiBase(): string | undefined {
  if (typeof window === "undefined") return undefined;
  const base = (window as ElizaWindow).__ELIZAOS_APP_BOOT_CONFIG__?.apiBase;
  return typeof base === "string" && base.trim().length > 0 ? base : undefined;
}

function assertNonEmptyText(text: unknown): string {
  if (typeof text !== "string" || text.trim().length === 0) {
    throw new Error("Agent.chat requires non-empty text");
  }
  return text;
}

function assertRequestPath(path: unknown): string {
  if (typeof path !== "string" || path.trim().length === 0) {
    throw new Error("Agent.request path must start with /");
  }
  const trimmed = path.trim();
  if (
    !trimmed.startsWith("/") ||
    trimmed.startsWith("//") ||
    trimmed.includes("\\")
  ) {
    throw new Error(
      "Agent.request requires a local path that starts with / and is not an absolute URL",
    );
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol) {
      throw new Error(
        "Agent.request requires a local path that starts with / and is not an absolute URL",
      );
    }
  } catch (err) {
    // error-policy:J3 untrusted path input — new URL() throws on the valid
    // relative-path case, so only our own absolute-URL rejection rethrows;
    // a genuine relative path falls through to the validated return below.
    if (err instanceof Error && err.message.includes("absolute URL")) {
      throw err;
    }
  }
  return trimmed;
}

function assertRequestMethod(method: unknown): string {
  if (method === undefined) return "GET";
  if (typeof method !== "string") {
    throw new Error("Unsupported HTTP method");
  }
  const normalized = method.trim().toUpperCase();
  if (!/^[A-Z]{1,16}$/.test(normalized)) {
    throw new Error("Unsupported HTTP method");
  }
  return normalized;
}

/**
 * Web fallback implementation.
 *
 * On non-desktop platforms (iOS, Android, web), the agent runtime runs
 * on a server. This implementation delegates to the HTTP API.
 *
 * In Electrobun the desktop bridge calls the native main-process
 * implementation via RPC instead — this web fallback is only used when
 * no native plugin is available. If the page is served from a non-HTTP
 * origin (e.g. electrobun://), relative fetches would hit the
 * app shell HTML, so we bail early.
 *
 * Local-agent-on-Android (Phase E): when the host UI selects the
 * "Local Agent" tile, it sets `apiBase` to `http://127.0.0.1:31337`,
 * which the runtime records in the boot config. From this
 * plugin's perspective there is no special case — it simply HTTP-POSTs
 * to `${apiBase}/api/agent/start|stop|status`, which is exactly the same
 * surface Phase B's `ElizaAgentService` exposes. The web fallback path
 * therefore works unchanged for both remote and on-device agents.
 */
export class AgentWeb extends WebPlugin implements AgentPlugin {
  private legacyConversationStorageKey(): string {
    const base =
      this.apiBase() ||
      (typeof window !== "undefined" ? window.location.origin : "same-origin");
    return `eliza_agent_web_conversation:${encodeURIComponent(base)}`;
  }

  private readLegacyConversationId(): string | null {
    if (typeof window === "undefined") return null;
    const stored = window.sessionStorage.getItem(
      this.legacyConversationStorageKey(),
    );
    return stored?.trim() ? stored.trim() : null;
  }

  private writeLegacyConversationId(conversationId: string | null): void {
    if (typeof window === "undefined") return;
    const key = this.legacyConversationStorageKey();
    if (conversationId?.trim()) {
      window.sessionStorage.setItem(key, conversationId.trim());
      return;
    }
    window.sessionStorage.removeItem(key);
  }

  private async ensureLegacyConversationId(): Promise<string> {
    const cached = this.readLegacyConversationId();
    if (cached) return cached;

    const res = await fetch(`${this.apiBase()}/api/conversations`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...this.authHeaders(),
      },
      body: JSON.stringify({ title: "Quick Chat" }),
    });
    if (!res.ok) {
      throw new Error(`Failed to create conversation: ${res.status}`);
    }
    const data = (await res.json()) as {
      conversation?: { id?: string };
    };
    const conversationId = data.conversation?.id?.trim();
    if (!conversationId) {
      throw new Error("Conversation create response missing id");
    }
    this.writeLegacyConversationId(conversationId);
    return conversationId;
  }

  private async chatViaConversation(
    text: string,
    retryOnMissingConversation = true,
  ): Promise<ChatResult> {
    const conversationId = await this.ensureLegacyConversationId();
    // @duplicate-component-audit-allow: agent API message POST; server-side runtime owns model trajectory logging.
    const res = await fetch(
      `${this.apiBase()}/api/conversations/${encodeURIComponent(conversationId)}/messages`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...this.authHeaders(),
        },
        body: JSON.stringify({ text, channelType: "DM" }),
      },
    );

    if (res.status === 404 && retryOnMissingConversation) {
      this.writeLegacyConversationId(null);
      return this.chatViaConversation(text, false);
    }

    if (!res.ok) {
      throw new Error(`Chat request failed: ${res.status}`);
    }

    return res.json();
  }

  private apiBase(): string {
    // No explicit base — use relative URLs (works on http/https origins).
    return readConfiguredApiBase() ?? "";
  }

  private isLocalAgentIpcBase(): boolean {
    const base = this.apiBase().trim();
    if (!base) return false;
    const lower = base.toLowerCase();
    if (
      lower === "eliza-local-agent://ipc" ||
      lower.startsWith("eliza-local-agent://ipc/") ||
      lower.startsWith("eliza-local-agent://ipc?")
    ) {
      return true;
    }
    try {
      const parsed = new URL(base);
      return (
        parsed.protocol === "eliza-local-agent:" &&
        (parsed.hostname === "ipc" ||
          parsed.pathname === "//ipc" ||
          parsed.pathname.startsWith("//ipc/"))
      );
    } catch {
      // error-policy:J3 untrusted base input — an unparseable base is simply
      // not a local-agent IPC base; the predicate reports false, not a failure.
      return false;
    }
  }

  private apiToken(): string | null {
    const global =
      typeof window !== "undefined"
        ? (window as ElizaWindow).__ELIZA_API_TOKEN__
        : undefined;
    if (typeof global === "string" && global.trim()) return global.trim();
    if (typeof window === "undefined") return null;
    const stored = window.sessionStorage.getItem("eliza_api_token");
    return stored?.trim() ? stored.trim() : null;
  }

  private authHeaders(): Record<string, string> {
    const token = this.apiToken();
    return token ? { Authorization: `Bearer ${token}` } : {};
  }

  private canReachApi(): boolean {
    if (this.isLocalAgentIpcBase()) return false;
    if (readConfiguredApiBase()) return true;
    // No explicit base — relative fetches only work on http(s) origins.
    if (typeof window === "undefined") return false;
    const proto = window.location.protocol;
    return proto === "http:" || proto === "https:";
  }

  async start(_options?: AgentStartOptions): Promise<AgentStatus> {
    if (!this.canReachApi()) {
      return {
        state: "not_started",
        agentName: null,
        port: null,
        startedAt: null,
        error: "No API endpoint",
      };
    }
    const res = await fetch(`${this.apiBase()}/api/agent/start`, {
      method: "POST",
      headers: this.authHeaders(),
    });
    const data = await res.json();
    return data.status ?? data;
  }

  async stop(): Promise<{ ok: boolean }> {
    if (!this.canReachApi()) {
      return { ok: false };
    }
    const res = await fetch(`${this.apiBase()}/api/agent/stop`, {
      method: "POST",
      headers: this.authHeaders(),
    });
    return res.json();
  }

  async getStatus(): Promise<AgentStatus> {
    if (!this.canReachApi()) {
      return {
        state: "not_started",
        agentName: null,
        port: null,
        startedAt: null,
        error: "No API endpoint",
      };
    }
    const res = await fetch(`${this.apiBase()}/api/status`, {
      headers: this.authHeaders(),
    });
    return res.json();
  }

  async chat(options: { text: string }): Promise<ChatResult> {
    const text = assertNonEmptyText(options.text);
    if (!this.canReachApi()) {
      return { text: "Agent API not available", agentName: "System" };
    }
    return this.chatViaConversation(text);
  }

  async getLocalAgentToken(): Promise<LocalAgentTokenResult> {
    const token = this.apiToken();
    return {
      available: Boolean(token),
      token,
    };
  }

  async request(options: AgentRequestOptions): Promise<AgentRequestResult> {
    const path = assertRequestPath(options.path);
    const method = assertRequestMethod(options.method);
    if (this.isLocalAgentIpcBase()) {
      return {
        status: 503,
        statusText: "Service Unavailable",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          error: "native_agent_unavailable",
          message:
            "Agent web fallback cannot handle eliza-local-agent://ipc; use the native Capacitor Agent plugin",
        }),
      };
    }
    const res = await fetch(`${this.apiBase()}${path}`, {
      method,
      headers: {
        ...this.authHeaders(),
        ...options.headers,
      },
      body: options.body ?? undefined,
    });
    const headers: Record<string, string> = {};
    res.headers.forEach((value, key) => {
      headers[key] = value;
    });
    return {
      status: res.status,
      statusText: res.statusText,
      headers,
      body: await res.text(),
    };
  }
}
