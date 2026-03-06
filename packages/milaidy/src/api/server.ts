/**
 * REST API server for the Milaidy Control UI.
 *
 * Exposes HTTP endpoints that the UI frontend expects, backed by the
 * elizaOS AgentRuntime. Designed to run on port 3001 alongside the
 * Vite dev server on port 3000 (which proxies /api and /ws here).
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import {
  AgentRuntime,
  type UUID,
} from "@elizaos/core";
import {
  loadMilaidyConfig,
  saveMilaidyConfig,
  configFileExists,
  type MilaidyConfig,
} from "../config/config.js";
import {
  resolveDefaultAgentWorkspaceDir,
} from "../providers/workspace.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ServerState {
  runtime: AgentRuntime | null;
  config: MilaidyConfig;
  agentState: "not_started" | "running" | "paused" | "stopped";
  agentName: string;
  model: string | undefined;
  startedAt: number | undefined;
  plugins: PluginEntry[];
  skills: SkillEntry[];
  logBuffer: LogEntry[];
  chatRoomId: UUID | null;
  chatUserId: UUID | null;
}

interface PluginEntry {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  configured: boolean;
  envKey: string | null;
  category: "provider" | "channel" | "core" | "feature";
  configKeys: string[];
}

interface SkillEntry {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
}

interface LogEntry {
  timestamp: number;
  level: string;
  message: string;
  source: string;
}

// ---------------------------------------------------------------------------
// Plugin discovery
// ---------------------------------------------------------------------------

function discoverPluginsFromDirectory(): PluginEntry[] {
  const pluginsDir = path.resolve(
    import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname),
    "../../../../plugins",
  );

  const entries: PluginEntry[] = [];
  if (!fs.existsSync(pluginsDir)) return entries;

  for (const dir of fs.readdirSync(pluginsDir)) {
    const tsPackageJson = path.join(pluginsDir, dir, "typescript", "package.json");
    const rootPackageJson = path.join(pluginsDir, dir, "package.json");
    const pkgPath = fs.existsSync(tsPackageJson) ? tsPackageJson : rootPackageJson;

    if (!fs.existsSync(pkgPath)) continue;

    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as Record<string, unknown>;
      const agentConfig = pkg.agentConfig as Record<string, unknown> | undefined;
      const pluginParams = (agentConfig?.pluginParameters ?? {}) as Record<string, unknown>;
      const configKeys = Object.keys(pluginParams);

      const id = dir.replace(/^plugin-/, "");
      const name = (pkg.name as string) ?? id;
      const description = (pkg.description as string) ?? "";

      // Determine category from the plugin id
      const category = categorizePlugin(id);

      // Check if the env key for this plugin is set
      const envKey = findEnvKey(id, configKeys);
      const configured = envKey ? Boolean(process.env[envKey]) : configKeys.length === 0;

      entries.push({
        id,
        name: formatPluginName(id),
        description,
        enabled: false, // will be updated from runtime
        configured,
        envKey,
        category,
        configKeys,
      });
    } catch (err) {
      console.debug(`[milaidy-api] Skipping plugin ${dir}: ${err instanceof Error ? err.message : err}`);
    }
  }

  return entries.sort((a, b) => a.name.localeCompare(b.name));
}

function categorizePlugin(id: string): "provider" | "channel" | "core" | "feature" {
  const providers = [
    "openai", "anthropic", "groq", "xai", "ollama", "openrouter",
    "google-genai", "local-ai", "vercel-ai-gateway", "deepseek",
    "together", "mistral", "cohere", "perplexity", "qwen", "minimax",
  ];
  const channels = [
    "telegram", "discord", "slack", "whatsapp", "signal", "imessage",
    "bluebubbles", "farcaster", "bluesky", "matrix", "nostr", "msteams",
    "mattermost", "google-chat", "feishu", "line", "zalo", "zalouser",
    "tlon", "twitch", "nextcloud-talk", "instagram",
  ];
  const core = ["sql", "localdb", "inmemorydb"];

  if (providers.includes(id)) return "provider";
  if (channels.includes(id)) return "channel";
  if (core.includes(id)) return "core";
  return "feature";
}

function findEnvKey(id: string, configKeys: string[]): string | null {
  // Common patterns: PLUGIN_API_KEY, PLUGIN_BOT_TOKEN
  const keyPatterns = configKeys.filter(
    (k) => k.endsWith("_API_KEY") || k.endsWith("_BOT_TOKEN") || k.endsWith("_TOKEN"),
  );
  return keyPatterns[0] ?? null;
}

function formatPluginName(id: string): string {
  return id
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

// ---------------------------------------------------------------------------
// Skills discovery
// ---------------------------------------------------------------------------

function discoverSkills(workspaceDir: string): SkillEntry[] {
  const skillsDirs = [
    path.resolve(
      import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname),
      "../../../skills",
    ),
    path.join(workspaceDir, "skills"),
  ];

  const skills: SkillEntry[] = [];
  const seen = new Set<string>();

  for (const dir of skillsDirs) {
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir)) {
      if (seen.has(entry)) continue;
      const skillDir = path.join(dir, entry);
      const skillMd = path.join(skillDir, "SKILL.md");
      if (!fs.existsSync(skillMd)) continue;

      seen.add(entry);
      const content = fs.readFileSync(skillMd, "utf-8");
      const firstLine = content.split("\n").find((l) => l.trim().startsWith("#"))?.replace(/^#+\s*/, "").trim() ?? entry;
      const descLine = content.split("\n").find((l) => l.trim() && !l.trim().startsWith("#"))?.trim() ?? "";

      skills.push({
        id: entry,
        name: firstLine,
        description: descLine.slice(0, 200),
        enabled: true,
      });
    }
  }

  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------------------
// Request helpers
// ---------------------------------------------------------------------------

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

function json(res: http.ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(JSON.stringify(data));
}

function error(res: http.ServerResponse, message: string, status = 400): void {
  json(res, { error: message }, status);
}

// ---------------------------------------------------------------------------
// Onboarding helpers
// ---------------------------------------------------------------------------

const STYLE_PRESETS = [
  { catchphrase: "uwu~", hint: "soft & sweet", bio: "Speaks softly and kindly.", style: "Write in a warm, gentle tone." },
  { catchphrase: "hell yeah", hint: "bold & fearless", bio: "Bold and direct.", style: "Write with confidence and energy." },
  { catchphrase: "lol k", hint: "terminally online", bio: "Internet native.", style: "Write casually with internet slang." },
  { catchphrase: "Noted.", hint: "composed & precise", bio: "Measured and thoughtful.", style: "Write precisely and concisely." },
  { catchphrase: "hehe~", hint: "playful trickster", bio: "Playful and mischievous.", style: "Write playfully with wit." },
  { catchphrase: "...", hint: "quiet intensity", bio: "Few words, deep meaning.", style: "Write tersely but meaningfully." },
];

const NAME_PRESETS = ["Reimu", "Flandre", "Sakuya", "Cirno", "Marisa", "Remilia"];

function getProviderOptions(): Array<{
  id: string;
  name: string;
  envKey: string | null;
  pluginName: string;
  keyPrefix: string | null;
  description: string;
}> {
  return [
    { id: "anthropic", name: "Anthropic", envKey: "ANTHROPIC_API_KEY", pluginName: "@elizaos/plugin-anthropic", keyPrefix: "sk-ant-", description: "Claude models." },
    { id: "openai", name: "OpenAI", envKey: "OPENAI_API_KEY", pluginName: "@elizaos/plugin-openai", keyPrefix: "sk-", description: "GPT models." },
    { id: "groq", name: "Groq", envKey: "GROQ_API_KEY", pluginName: "@elizaos/plugin-groq", keyPrefix: "gsk_", description: "Fast inference." },
    { id: "ollama", name: "Ollama (local)", envKey: null, pluginName: "@elizaos/plugin-ollama", keyPrefix: null, description: "Local models." },
  ];
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  state: ServerState,
): Promise<void> {
  const method = req.method ?? "GET";
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const pathname = url.pathname;

  // CORS preflight
  if (method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    res.end();
    return;
  }

  // ── GET /api/status ─────────────────────────────────────────────────────
  if (method === "GET" && pathname === "/api/status") {
    const uptime = state.startedAt ? Date.now() - state.startedAt : undefined;
    json(res, {
      state: state.agentState,
      agentName: state.agentName,
      model: state.model,
      uptime,
      startedAt: state.startedAt,
    });
    return;
  }

  // ── GET /api/onboarding/status ──────────────────────────────────────────
  if (method === "GET" && pathname === "/api/onboarding/status") {
    const complete = configFileExists() && Boolean(state.config.agents);
    json(res, { complete });
    return;
  }

  // ── GET /api/onboarding/options ─────────────────────────────────────────
  if (method === "GET" && pathname === "/api/onboarding/options") {
    json(res, {
      names: NAME_PRESETS,
      styles: STYLE_PRESETS,
      providers: getProviderOptions(),
      sharedStyleRules: "Keep responses brief. Be helpful and concise.",
    });
    return;
  }

  // ── POST /api/onboarding ────────────────────────────────────────────────
  if (method === "POST" && pathname === "/api/onboarding") {
    const body = JSON.parse(await readBody(req)) as Record<string, string>;
    const config = state.config;

    // Update config with onboarding data
    if (!config.agents) config.agents = {};
    if (!config.agents.defaults) config.agents.defaults = {};
    config.agents.defaults.workspace = resolveDefaultAgentWorkspaceDir();

    if (!config.agents.list) config.agents.list = [];
    if (config.agents.list.length === 0) {
      config.agents.list.push({
        id: "main",
        default: true,
        name: body.name,
        workspace: resolveDefaultAgentWorkspaceDir(),
      } as Record<string, unknown>);
    }

    // Store provider API key in env config
    if (body.provider && body.providerApiKey) {
      if (!config.env) config.env = {};
      const providerOpt = getProviderOptions().find((p) => p.id === body.provider);
      if (providerOpt?.envKey) {
        (config.env as Record<string, string>)[providerOpt.envKey] = body.providerApiKey;
        process.env[providerOpt.envKey] = body.providerApiKey;
      }
    }

    // Store channel tokens
    if (body.telegramBotToken) {
      if (!config.env) config.env = {};
      (config.env as Record<string, string>).TELEGRAM_BOT_TOKEN = body.telegramBotToken;
      process.env.TELEGRAM_BOT_TOKEN = body.telegramBotToken;
    }
    if (body.discordBotToken) {
      if (!config.env) config.env = {};
      (config.env as Record<string, string>).DISCORD_API_TOKEN = body.discordBotToken;
      process.env.DISCORD_API_TOKEN = body.discordBotToken;
    }

    state.config = config;
    state.agentName = body.name ?? state.agentName;
    saveMilaidyConfig(config);
    json(res, { ok: true });
    return;
  }

  // ── POST /api/agent/start ───────────────────────────────────────────────
  if (method === "POST" && pathname === "/api/agent/start") {
    state.agentState = "running";
    state.startedAt = Date.now();
    // Detect model from runtime plugins or fall back to "unknown"
    const detectedModel = state.runtime
      ? (state.runtime.plugins.find((p) => p.name.includes("anthropic") || p.name.includes("openai") || p.name.includes("groq"))?.name ?? "unknown")
      : "unknown";
    state.model = detectedModel;
    json(res, {
      ok: true,
      status: {
        state: state.agentState,
        agentName: state.agentName,
        model: state.model,
        uptime: 0,
        startedAt: state.startedAt,
      },
    });
    return;
  }

  // ── POST /api/agent/stop ────────────────────────────────────────────────
  if (method === "POST" && pathname === "/api/agent/stop") {
    state.agentState = "stopped";
    state.startedAt = undefined;
    state.model = undefined;
    json(res, {
      ok: true,
      status: {
        state: state.agentState,
        agentName: state.agentName,
        model: undefined,
        uptime: undefined,
        startedAt: undefined,
      },
    });
    return;
  }

  // ── POST /api/agent/pause ───────────────────────────────────────────────
  if (method === "POST" && pathname === "/api/agent/pause") {
    state.agentState = "paused";
    json(res, {
      ok: true,
      status: {
        state: state.agentState,
        agentName: state.agentName,
        model: state.model,
        uptime: state.startedAt ? Date.now() - state.startedAt : undefined,
        startedAt: state.startedAt,
      },
    });
    return;
  }

  // ── POST /api/agent/resume ──────────────────────────────────────────────
  if (method === "POST" && pathname === "/api/agent/resume") {
    state.agentState = "running";
    json(res, {
      ok: true,
      status: {
        state: state.agentState,
        agentName: state.agentName,
        model: state.model,
        uptime: state.startedAt ? Date.now() - state.startedAt : undefined,
        startedAt: state.startedAt,
      },
    });
    return;
  }

  // ── POST /api/agent/autonomy ────────────────────────────────────────────
  if (method === "POST" && pathname === "/api/agent/autonomy") {
    const body = JSON.parse(await readBody(req)) as { enabled?: boolean };
    const enabled = body.enabled ?? false;
    if (state.runtime) {
      state.runtime.enableAutonomy = enabled;
    }
    json(res, { ok: true, autonomy: enabled });
    return;
  }

  // ── GET /api/agent/autonomy ─────────────────────────────────────────────
  if (method === "GET" && pathname === "/api/agent/autonomy") {
    json(res, { enabled: state.runtime?.enableAutonomy ?? false });
    return;
  }

  // ── GET /api/config ─────────────────────────────────────────────────────
  if (method === "GET" && pathname === "/api/config") {
    json(res, state.config);
    return;
  }

  // ── PUT /api/config ─────────────────────────────────────────────────────
  if (method === "PUT" && pathname === "/api/config") {
    const body = JSON.parse(await readBody(req)) as MilaidyConfig;
    state.config = body;
    saveMilaidyConfig(body);
    json(res, { ok: true });
    return;
  }

  // ── GET /api/plugins ────────────────────────────────────────────────────
  if (method === "GET" && pathname === "/api/plugins") {
    // Update enabled status from runtime
    if (state.runtime) {
      const loadedNames = new Set(state.runtime.plugins.map((p) => p.name));
      for (const plugin of state.plugins) {
        plugin.enabled = loadedNames.has(plugin.id) || loadedNames.has(`plugin-${plugin.id}`);
      }
    }
    json(res, { plugins: state.plugins });
    return;
  }

  // ── PUT /api/plugins/:id ────────────────────────────────────────────────
  if (method === "PUT" && pathname.startsWith("/api/plugins/")) {
    const pluginId = pathname.slice("/api/plugins/".length);
    const body = JSON.parse(await readBody(req)) as { enabled?: boolean; config?: Record<string, string> };

    const plugin = state.plugins.find((p) => p.id === pluginId);
    if (!plugin) {
      error(res, `Plugin "${pluginId}" not found`, 404);
      return;
    }

    if (body.enabled !== undefined) {
      plugin.enabled = body.enabled;
    }
    if (body.config) {
      // Set env vars for this plugin
      for (const [key, value] of Object.entries(body.config)) {
        if (value) process.env[key] = value;
      }
      plugin.configured = true;
    }

    json(res, { ok: true, plugin });
    return;
  }

  // ── GET /api/skills ─────────────────────────────────────────────────────
  if (method === "GET" && pathname === "/api/skills") {
    json(res, { skills: state.skills });
    return;
  }

  // ── GET /api/logs ───────────────────────────────────────────────────────
  if (method === "GET" && pathname === "/api/logs") {
    json(res, { entries: state.logBuffer.slice(-200) });
    return;
  }

  // ── POST /api/chat ──────────────────────────────────────────────────────
  if (method === "POST" && pathname === "/api/chat") {
    const body = JSON.parse(await readBody(req)) as { text?: string };
    if (!body.text?.trim()) {
      error(res, "text is required");
      return;
    }

    if (!state.runtime) {
      error(res, "Agent is not running", 503);
      return;
    }

    try {
      const result = await state.runtime.generateText(body.text.trim(), {
        maxTokens: 2048,
      });
      json(res, { text: result.text, agentName: state.agentName });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "generation failed";
      error(res, msg, 500);
    }
    return;
  }

  // ── Fallback ────────────────────────────────────────────────────────────
  error(res, "Not found", 404);
}

// ---------------------------------------------------------------------------
// Server start
// ---------------------------------------------------------------------------

export async function startApiServer(opts?: {
  port?: number;
  /** Pre-initialized runtime for testing. When provided, the server starts in "running" state. */
  runtime?: AgentRuntime;
}): Promise<{ port: number; close: () => Promise<void> }> {
  const port = opts?.port ?? 3001;

  // Load config
  let config: MilaidyConfig;
  try {
    config = loadMilaidyConfig();
  } catch (err) {
    console.warn("[milaidy-api] Failed to load config, starting with defaults:", err instanceof Error ? err.message : err);
    config = {} as MilaidyConfig;
  }

  // Discover plugins and skills
  const plugins = discoverPluginsFromDirectory();
  const workspaceDir = config.agents?.defaults?.workspace ?? resolveDefaultAgentWorkspaceDir();
  const skills = discoverSkills(workspaceDir);

  const hasRuntime = opts?.runtime != null;
  const agentName = hasRuntime
    ? (opts.runtime.character.name ?? "Milaidy")
    : ((config.agents?.list as Array<{ name?: string }> | undefined)?.[0]?.name ?? "Milaidy");

  const state: ServerState = {
    runtime: opts?.runtime ?? null,
    config,
    agentState: hasRuntime ? "running" : "not_started",
    agentName,
    model: hasRuntime ? "provided" : undefined,
    startedAt: hasRuntime ? Date.now() : undefined,
    plugins,
    skills,
    logBuffer: [],
    chatRoomId: null,
    chatUserId: null,
  };

  // Add a log interceptor
  const addLog = (level: string, message: string, source = "system") => {
    state.logBuffer.push({ timestamp: Date.now(), level, message, source });
    if (state.logBuffer.length > 1000) state.logBuffer.shift();
  };

  addLog("info", `Discovered ${plugins.length} plugins, ${skills.length} skills`);

  const server = http.createServer(async (req, res) => {
    try {
      await handleRequest(req, res, state);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "internal error";
      addLog("error", msg, "api");
      error(res, msg, 500);
    }
  });

  return new Promise((resolve) => {
    server.listen(port, () => {
      const addr = server.address();
      const actualPort = typeof addr === "object" && addr ? addr.port : port;
      addLog("info", `API server listening on http://localhost:${actualPort}`);
      console.log(`[milaidy-api] Listening on http://localhost:${actualPort}`);
      resolve({
        port: actualPort,
        close: () =>
          new Promise<void>((r) => {
            server.close(() => r());
          }),
      });
    });
  });
}
