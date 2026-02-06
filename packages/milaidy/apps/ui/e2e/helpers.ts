/**
 * Shared E2E test helpers.
 *
 * Mocks API responses so tests run deterministically without a real backend.
 * When MILAIDY_E2E_REAL=1, mocks are not applied and tests hit the real API.
 */

import type { Page, Route } from "@playwright/test";

export interface MockApiOptions {
  onboardingComplete?: boolean;
  agentState?: "not_started" | "running" | "paused" | "stopped";
  agentName?: string;
  pluginCount?: number;
  skillCount?: number;
  logCount?: number;
  autonomyEnabled?: boolean;
}

export interface MockPlugin {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  configured: boolean;
  envKey: string | null;
  category: "provider" | "channel" | "core" | "feature";
  configKeys: string[];
}

const DEFAULT_PLUGINS: MockPlugin[] = [
  { id: "anthropic", name: "Anthropic", description: "Claude models via Anthropic API", enabled: true, configured: true, envKey: "ANTHROPIC_API_KEY", category: "provider", configKeys: ["ANTHROPIC_API_KEY"] },
  { id: "openai", name: "OpenAI", description: "GPT models via OpenAI API", enabled: true, configured: true, envKey: "OPENAI_API_KEY", category: "provider", configKeys: ["OPENAI_API_KEY"] },
  { id: "groq", name: "Groq", description: "Fast inference with Groq", enabled: false, configured: false, envKey: "GROQ_API_KEY", category: "provider", configKeys: ["GROQ_API_KEY"] },
  { id: "ollama", name: "Ollama", description: "Local models via Ollama", enabled: false, configured: false, envKey: null, category: "provider", configKeys: [] },
  { id: "telegram", name: "Telegram", description: "Telegram bot integration", enabled: false, configured: false, envKey: "TELEGRAM_BOT_TOKEN", category: "channel", configKeys: ["TELEGRAM_BOT_TOKEN"] },
  { id: "discord", name: "Discord", description: "Discord bot integration", enabled: false, configured: false, envKey: "DISCORD_API_TOKEN", category: "channel", configKeys: ["DISCORD_API_TOKEN"] },
  { id: "slack", name: "Slack", description: "Slack bot integration", enabled: false, configured: false, envKey: "SLACK_BOT_TOKEN", category: "channel", configKeys: ["SLACK_BOT_TOKEN"] },
  { id: "browser", name: "Browser", description: "Browser automation tools", enabled: true, configured: true, envKey: null, category: "feature", configKeys: [] },
  { id: "shell", name: "Shell", description: "Shell command execution", enabled: false, configured: false, envKey: null, category: "feature", configKeys: ["SHELL_ALLOWED_DIRECTORY"] },
  { id: "sql", name: "SQL", description: "SQL database adapter", enabled: true, configured: true, envKey: null, category: "core", configKeys: [] },
  { id: "cron", name: "Cron", description: "Scheduled task execution", enabled: false, configured: false, envKey: null, category: "feature", configKeys: [] },
  { id: "knowledge", name: "Knowledge", description: "RAG knowledge base", enabled: false, configured: false, envKey: null, category: "feature", configKeys: ["CTX_KNOWLEDGE_ENABLED"] },
];

const DEFAULT_SKILLS = [
  { id: "web-search", name: "Web Search", description: "Search the web for information", enabled: true },
  { id: "code-review", name: "Code Review", description: "Review and analyze code", enabled: true },
  { id: "image-gen", name: "Image Generation", description: "Generate images from text prompts", enabled: false },
];

const DEFAULT_LOGS = [
  { timestamp: Date.now() - 60000, level: "info", message: "Agent started successfully", source: "system" },
  { timestamp: Date.now() - 30000, level: "info", message: "Loaded 12 plugins", source: "plugin-loader" },
  { timestamp: Date.now() - 15000, level: "warn", message: "Telegram token not configured", source: "plugin-telegram" },
  { timestamp: Date.now() - 5000, level: "info", message: "Ready for messages", source: "message-service" },
];

export async function mockApi(page: Page, opts: MockApiOptions = {}): Promise<void> {
  const onboardingComplete = opts.onboardingComplete ?? true;
  const agentState = opts.agentState ?? "running";
  const agentName = opts.agentName ?? "Reimu";
  const autonomyEnabled = opts.autonomyEnabled ?? false;

  // State tracking for stateful mocks
  let currentState = agentState;
  let currentAutonomy = autonomyEnabled;
  const pluginStates = new Map<string, boolean>();
  for (const p of DEFAULT_PLUGINS) pluginStates.set(p.id, p.enabled);

  // Mock /api/status
  await page.route("**/api/status", async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        state: currentState,
        agentName,
        model: currentState === "running" || currentState === "paused" ? "anthropic/claude-opus-4-5" : undefined,
        uptime: currentState !== "not_started" && currentState !== "stopped" ? 60000 : undefined,
        startedAt: currentState !== "not_started" && currentState !== "stopped" ? Date.now() - 60000 : undefined,
      }),
    });
  });

  // Mock /api/onboarding/status
  await page.route("**/api/onboarding/status", async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ complete: onboardingComplete }),
    });
  });

  // Mock /api/onboarding/options
  await page.route("**/api/onboarding/options", async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        names: ["Reimu", "Flandre", "Sakuya", "Cirno"],
        styles: [
          { catchphrase: "uwu~", hint: "soft & sweet", bio: "Speaks softly.", style: "Write softly." },
          { catchphrase: "hell yeah", hint: "bold & fearless", bio: "Bold and direct.", style: "Write boldly." },
          { catchphrase: "lol k", hint: "terminally online", bio: "Internet native.", style: "Write casually." },
          { catchphrase: "Noted.", hint: "composed & precise", bio: "Measured.", style: "Write precisely." },
          { catchphrase: "hehe~", hint: "playful trickster", bio: "Playful.", style: "Write playfully." },
          { catchphrase: "...", hint: "quiet intensity", bio: "Few words.", style: "Write tersely." },
        ],
        providers: [
          { id: "elizacloud", name: "Eliza Cloud", envKey: null, pluginName: "@elizaos/plugin-elizacloud", keyPrefix: null, description: "Free credits." },
          { id: "anthropic", name: "Anthropic", envKey: "ANTHROPIC_API_KEY", pluginName: "@elizaos/plugin-anthropic", keyPrefix: "sk-ant-", description: "Claude." },
          { id: "openai", name: "OpenAI", envKey: "OPENAI_API_KEY", pluginName: "@elizaos/plugin-openai", keyPrefix: "sk-", description: "GPT." },
        ],
        sharedStyleRules: "Keep responses brief.",
      }),
    });
  });

  // Mock /api/onboarding (POST)
  await page.route("**/api/onboarding", async (route: Route) => {
    if (route.request().method() === "POST") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true }),
      });
    }
  });

  // Mock /api/agent/start
  await page.route("**/api/agent/start", async (route: Route) => {
    currentState = "running";
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        status: { state: "running", agentName, model: "anthropic/claude-opus-4-5", uptime: 0, startedAt: Date.now() },
      }),
    });
  });

  // Mock /api/agent/stop
  await page.route("**/api/agent/stop", async (route: Route) => {
    currentState = "stopped";
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        status: { state: "stopped", agentName, model: undefined, uptime: undefined, startedAt: undefined },
      }),
    });
  });

  // Mock /api/agent/pause
  await page.route("**/api/agent/pause", async (route: Route) => {
    currentState = "paused";
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        status: { state: "paused", agentName, model: "anthropic/claude-opus-4-5", uptime: 60000, startedAt: Date.now() - 60000 },
      }),
    });
  });

  // Mock /api/agent/resume
  await page.route("**/api/agent/resume", async (route: Route) => {
    currentState = "running";
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        status: { state: "running", agentName, model: "anthropic/claude-opus-4-5", uptime: 60000, startedAt: Date.now() - 60000 },
      }),
    });
  });

  // Mock /api/agent/autonomy GET
  await page.route("**/api/agent/autonomy", async (route: Route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ enabled: currentAutonomy }),
      });
    } else if (route.request().method() === "POST") {
      const body = route.request().postDataJSON() as { enabled?: boolean };
      currentAutonomy = body.enabled ?? false;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, autonomy: currentAutonomy }),
      });
    }
  });

  // Mock /api/config
  await page.route("**/api/config", async (route: Route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ agent: { name: agentName, bio: "Test agent." } }),
      });
    } else if (route.request().method() === "PUT") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true }),
      });
    }
  });

  // Mock /api/plugins (GET) and /api/plugins/:id (PUT)
  await page.route("**/api/plugins**", async (route: Route) => {
    const url = route.request().url();
    if (route.request().method() === "GET" && url.endsWith("/api/plugins")) {
      const plugins = DEFAULT_PLUGINS.map((p) => ({
        ...p,
        enabled: pluginStates.get(p.id) ?? p.enabled,
      }));
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ plugins }),
      });
    } else if (route.request().method() === "PUT") {
      // Extract plugin ID from URL
      const match = url.match(/\/api\/plugins\/([^/?]+)/);
      const pluginId = match?.[1];
      if (pluginId) {
        const body = route.request().postDataJSON() as { enabled?: boolean };
        if (body.enabled !== undefined) {
          pluginStates.set(pluginId, body.enabled);
        }
        const plugin = DEFAULT_PLUGINS.find((p) => p.id === pluginId);
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ ok: true, plugin: plugin ? { ...plugin, enabled: pluginStates.get(pluginId) ?? plugin.enabled } : null }),
        });
      }
    }
  });

  // Mock /api/skills
  await page.route("**/api/skills", async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ skills: opts.skillCount === 0 ? [] : DEFAULT_SKILLS }),
    });
  });

  // Mock /api/logs
  await page.route("**/api/logs", async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ entries: opts.logCount === 0 ? [] : DEFAULT_LOGS }),
    });
  });

  // Block WebSocket connections in tests
  await page.route("**/ws", async (route: Route) => {
    await route.abort();
  });
}

/**
 * Simulate an agent chat response by injecting it directly into the Lit
 * component state.  This sidesteps WebSocket (which is blocked in tests).
 */
export async function simulateAgentResponse(page: Page, text: string): Promise<void> {
  await page.evaluate((responseText: string) => {
    const app = document.querySelector("milaidy-app") as HTMLElement & {
      chatMessages: Array<{ role: string; text: string; timestamp: number }>;
      chatSending: boolean;
    };
    if (!app) throw new Error("milaidy-app not found");
    app.chatMessages = [
      ...app.chatMessages,
      { role: "assistant", text: responseText, timestamp: Date.now() },
    ];
    app.chatSending = false;
  }, text);
}
