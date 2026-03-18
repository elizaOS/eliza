import { WebPlugin } from "@capacitor/core";
import type { AgentPlugin, AgentStatus, ChatResult } from "./definitions";

/**
 * Web fallback implementation.
 *
 * On non-Electron platforms (iOS, Android, web), the agent runtime runs
 * on a server. This implementation delegates to the HTTP API.
 *
 * In Electron the Capacitor plugin bridge calls the native (main-process)
 * implementation via IPC instead — this web fallback is only used when
 * no native plugin is available.  If the page is served from a non-HTTP
 * origin (e.g. capacitor-electron://), relative fetches would hit the
 * app shell HTML, so we bail early.
 */
export class AgentWeb extends WebPlugin implements AgentPlugin {
  private electronLocalFallbackBase(): string {
    if (typeof window === "undefined") return "";
    const proto = window.location.protocol;
    if (proto === "capacitor-electron:") {
      return "http://localhost:2138";
    }
    if (proto === "file:" && /\bElectron\b/i.test(window.navigator.userAgent)) {
      return "http://localhost:2138";
    }
    return "";
  }

  private apiBase(): string {
    const global =
      typeof window !== "undefined"
        ? (window as unknown as Record<string, unknown>).__MILADY_API_BASE__
        : undefined;
    if (typeof global === "string" && global.trim().length > 0) return global;
    return this.electronLocalFallbackBase();
  }

  private apiToken(): string | null {
    const global =
      typeof window !== "undefined"
        ? (window as unknown as Record<string, unknown>).__MILADY_API_TOKEN__
        : undefined;
    if (typeof global === "string" && global.trim()) return global.trim();
    if (typeof window === "undefined") return null;
    const stored = window.sessionStorage.getItem("milady_api_token");
    return stored?.trim() ? stored.trim() : null;
  }

  private authHeaders(): Record<string, string> {
    const token = this.apiToken();
    return token ? { Authorization: `Bearer ${token}` } : {};
  }

  /** True when we can reach the API via HTTP. */
  private canReachApi(): boolean {
    const base = this.apiBase();
    if (base) return true;
    // No explicit base — relative fetches only work on http(s) origins.
    if (typeof window === "undefined") return false;
    const proto = window.location.protocol;
    return proto === "http:" || proto === "https:";
  }

  async start(): Promise<AgentStatus> {
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
    const res = await fetch(`${this.apiBase()}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...this.authHeaders() },
      body: JSON.stringify({ text: options.text }),
    });
    return res.json();
  }
}
