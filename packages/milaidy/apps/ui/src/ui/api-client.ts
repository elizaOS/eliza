/**
 * API client for the Milaidy backend.
 *
 * Thin fetch wrapper + WebSocket for real-time chat/events.
 * Replaces the gateway WebSocket protocol entirely.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AgentState = "not_started" | "running" | "paused" | "stopped";

export interface AgentStatus {
  state: AgentState;
  agentName: string;
  model: string | undefined;
  uptime: number | undefined;
  startedAt: number | undefined;
}

export interface StylePreset {
  catchphrase: string;
  hint: string;
  bio: string;
  style: string;
}

export interface ProviderOption {
  id: string;
  name: string;
  envKey: string | null;
  pluginName: string;
  keyPrefix: string | null;
  description: string;
}

export interface OnboardingOptions {
  names: string[];
  styles: StylePreset[];
  providers: ProviderOption[];
  sharedStyleRules: string;
}

export interface OnboardingData {
  name: string;
  bio: string;
  systemPrompt: string;
  provider?: string;
  providerApiKey?: string;
  telegramBotToken?: string;
  discordBotToken?: string;
}

export interface PluginInfo {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  configured: boolean;
  envKey: string | null;
  category: "provider" | "channel" | "core" | "feature";
}

export interface ChatMessage {
  role: "user" | "assistant";
  text: string;
  timestamp: number;
}

export interface SkillInfo {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
}

export interface LogEntry {
  timestamp: number;
  level: string;
  message: string;
  source: string;
}

// ---------------------------------------------------------------------------
// WebSocket event handler
// ---------------------------------------------------------------------------

export type WsEventHandler = (data: Record<string, unknown>) => void;

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class MilaidyClient {
  private baseUrl: string;
  private ws: WebSocket | null = null;
  private wsHandlers = new Map<string, Set<WsEventHandler>>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private backoffMs = 500;

  constructor(baseUrl?: string) {
    // Default to same origin (works in dev with Vite proxy)
    this.baseUrl = baseUrl ?? "";
  }

  // --- REST API ---

  private async fetch<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...init?.headers,
      },
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: res.statusText })) as Record<string, string>;
      throw new Error(body.error ?? `HTTP ${res.status}`);
    }
    return res.json() as Promise<T>;
  }

  async getStatus(): Promise<AgentStatus> {
    return this.fetch("/api/status");
  }

  async getOnboardingStatus(): Promise<{ complete: boolean }> {
    return this.fetch("/api/onboarding/status");
  }

  async getOnboardingOptions(): Promise<OnboardingOptions> {
    return this.fetch("/api/onboarding/options");
  }

  async submitOnboarding(data: OnboardingData): Promise<void> {
    await this.fetch("/api/onboarding", {
      method: "POST",
      body: JSON.stringify(data),
    });
  }

  async startAgent(): Promise<AgentStatus> {
    const res = await this.fetch<{ status: AgentStatus }>("/api/agent/start", { method: "POST" });
    return res.status;
  }

  async stopAgent(): Promise<AgentStatus> {
    const res = await this.fetch<{ status: AgentStatus }>("/api/agent/stop", { method: "POST" });
    return res.status;
  }

  async pauseAgent(): Promise<AgentStatus> {
    const res = await this.fetch<{ status: AgentStatus }>("/api/agent/pause", { method: "POST" });
    return res.status;
  }

  async resumeAgent(): Promise<AgentStatus> {
    const res = await this.fetch<{ status: AgentStatus }>("/api/agent/resume", { method: "POST" });
    return res.status;
  }

  async getConfig(): Promise<Record<string, unknown>> {
    return this.fetch("/api/config");
  }

  async updateConfig(config: Record<string, unknown>): Promise<void> {
    await this.fetch("/api/config", {
      method: "PUT",
      body: JSON.stringify(config),
    });
  }

  async getPlugins(): Promise<{ plugins: PluginInfo[] }> {
    return this.fetch("/api/plugins");
  }

  async updatePlugin(id: string, config: Record<string, unknown>): Promise<void> {
    await this.fetch(`/api/plugins/${id}`, {
      method: "PUT",
      body: JSON.stringify(config),
    });
  }

  async getSkills(): Promise<{ skills: SkillInfo[] }> {
    return this.fetch("/api/skills");
  }

  async getLogs(): Promise<{ entries: LogEntry[] }> {
    return this.fetch("/api/logs");
  }

  async getAutonomy(): Promise<{ enabled: boolean }> {
    return this.fetch("/api/agent/autonomy");
  }

  async setAutonomy(enabled: boolean): Promise<void> {
    await this.fetch("/api/agent/autonomy", {
      method: "POST",
      body: JSON.stringify({ enabled }),
    });
  }

  // --- WebSocket ---

  connectWs(): void {
    if (this.ws?.readyState === WebSocket.OPEN) return;

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const host = this.baseUrl
      ? new URL(this.baseUrl).host
      : window.location.host;
    const url = `${protocol}//${host}/ws`;

    this.ws = new WebSocket(url);

    this.ws.onopen = () => {
      this.backoffMs = 500;
    };

    this.ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data as string) as Record<string, unknown>;
        const type = data.type as string;
        const handlers = this.wsHandlers.get(type);
        if (handlers) {
          for (const handler of handlers) {
            handler(data);
          }
        }
        // Also fire "all" handlers
        const allHandlers = this.wsHandlers.get("*");
        if (allHandlers) {
          for (const handler of allHandlers) {
            handler(data);
          }
        }
      } catch {
        // ignore parse errors
      }
    };

    this.ws.onclose = () => {
      this.ws = null;
      this.scheduleReconnect();
    };

    this.ws.onerror = () => {
      // close handler will fire
    };
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connectWs();
    }, this.backoffMs);
    this.backoffMs = Math.min(this.backoffMs * 1.5, 10000);
  }

  onWsEvent(type: string, handler: WsEventHandler): () => void {
    if (!this.wsHandlers.has(type)) {
      this.wsHandlers.set(type, new Set());
    }
    this.wsHandlers.get(type)!.add(handler);
    return () => {
      this.wsHandlers.get(type)?.delete(handler);
    };
  }

  sendChat(text: string): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "chat", text }));
    }
  }

  disconnectWs(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
  }
}

// Singleton
export const client = new MilaidyClient();
