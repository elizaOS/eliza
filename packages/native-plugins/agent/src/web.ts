import { WebPlugin } from "@capacitor/core";
import type {
  AgentPlugin,
  AgentStartOptions,
  AgentRequestOptions,
  AgentRequestResult,
  AgentStatus,
  ChatResult,
  LocalAgentTokenResult,
} from "./definitions";

interface ElizaWindow extends Window {
  __ELIZA_API_BASE__?: string;
  __ELIZA_API_TOKEN__?: string;
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
 * which the runtime mirrors into `window.__ELIZA_API_BASE__`. From this
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
    const global =
      typeof window !== "undefined"
        ? (window as ElizaWindow).__ELIZA_API_BASE__
        : undefined;
    if (typeof global === "string" && global.trim().length > 0) return global;
    // No explicit base — use relative URLs (works on http/https origins).
    return "";
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

  /** True when we can reach the API via HTTP. */
  private canReachApi(): boolean {
    const global =
      typeof window !== "undefined"
        ? (window as ElizaWindow).__ELIZA_API_BASE__
        : undefined;
    if (typeof global === "string" && global.trim().length > 0) return true;
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
    if (!this.canReachApi()) {
      return { text: "Agent API not available", agentName: "System" };
    }
    return this.chatViaConversation(options.text);
  }

  async getLocalAgentToken(): Promise<LocalAgentTokenResult> {
    const token = this.apiToken();
    return {
      available: Boolean(token),
      token,
    };
  }

  async request(options: AgentRequestOptions): Promise<AgentRequestResult> {
    if (!options.path?.startsWith("/")) {
      throw new Error("Agent.request path must start with /");
    }
    const res = await fetch(`${this.apiBase()}${options.path}`, {
      method: options.method ?? "GET",
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
