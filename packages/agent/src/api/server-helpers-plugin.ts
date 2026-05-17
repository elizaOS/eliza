/**
 * Plugin config/form helpers extracted from server.ts.
 */

import { BLOCKED_ENV_KEYS } from "./plugin-discovery-helpers.ts";
import type { ServerState } from "./server-types.ts";

// ---------------------------------------------------------------------------
// Plugin config intent detection
// ---------------------------------------------------------------------------

// Matches: "set up telegram", "configure discord plugin", "connect slack",
// "help me with the openai plugin", etc.
const PLUGIN_CONFIG_RE =
  /\b(?:set\s*up|configure|connect|enable|install|setup)\b.*?\b(telegram|discord|twitter|slack|anthropic|openai|openrouter|groq|google|gemini|deepseek|mistral|together|grok|zai|moonshot|kimi|ollama)\b|\b(telegram|discord|twitter|slack|anthropic|openai|openrouter|groq|google|gemini|deepseek|mistral|together|grok|zai|moonshot|kimi|ollama)\b.*?\b(?:plugin|connector|set\s*up|configure|connect|enable|setup)\b/i;

const PLUGIN_PARAMS: Record<
  string,
  Array<{ key: string; label: string; secret: boolean }>
> = {
  telegram: [
    {
      key: "TELEGRAM_BOT_TOKEN",
      label: "Bot Token (from @BotFather)",
      secret: true,
    },
  ],
  discord: [
    { key: "DISCORD_API_TOKEN", label: "Bot Token", secret: true },
    {
      key: "DISCORD_APPLICATION_ID",
      label: "Application ID (optional, auto-resolved when omitted)",
      secret: false,
    },
  ],
  twitter: [
    { key: "TWITTER_USERNAME", label: "Username", secret: false },
    { key: "TWITTER_PASSWORD", label: "Password", secret: true },
    { key: "TWITTER_EMAIL", label: "Email", secret: false },
  ],
  slack: [
    { key: "SLACK_APP_TOKEN", label: "App Token", secret: true },
    { key: "SLACK_BOT_TOKEN", label: "Bot Token", secret: true },
    { key: "SLACK_SIGNING_SECRET", label: "Signing Secret", secret: true },
  ],
  anthropic: [
    {
      key: "ANTHROPIC_API_KEY",
      label: "API Key (console.anthropic.com)",
      secret: true,
    },
  ],
  openai: [
    {
      key: "OPENAI_API_KEY",
      label: "API Key (platform.openai.com)",
      secret: true,
    },
  ],
  openrouter: [
    {
      key: "OPENROUTER_API_KEY",
      label: "API Key (openrouter.ai)",
      secret: true,
    },
  ],
  groq: [
    { key: "GROQ_API_KEY", label: "API Key (console.groq.com)", secret: true },
  ],
  google: [
    { key: "GOOGLE_GENERATIVE_AI_API_KEY", label: "API Key", secret: true },
  ],
  gemini: [
    { key: "GOOGLE_GENERATIVE_AI_API_KEY", label: "API Key", secret: true },
  ],
  deepseek: [{ key: "DEEPSEEK_API_KEY", label: "API Key", secret: true }],
  mistral: [{ key: "MISTRAL_API_KEY", label: "API Key", secret: true }],
  together: [{ key: "TOGETHER_API_KEY", label: "API Key", secret: true }],
  grok: [{ key: "XAI_API_KEY", label: "API Key", secret: true }],
  zai: [{ key: "ZAI_API_KEY", label: "API Key", secret: true }],
  moonshot: [{ key: "MOONSHOT_API_KEY", label: "API Key", secret: true }],
  kimi: [{ key: "MOONSHOT_API_KEY", label: "API Key", secret: true }],
  ollama: [
    {
      key: "OLLAMA_BASE_URL",
      label: "Ollama URL (e.g. http://localhost:11434)",
      secret: false,
    },
  ],
};

export async function resolvePluginConfigReply(
  prompt: string,
  _state: Pick<ServerState, "config" | "runtime">,
): Promise<string | null> {
  const match = prompt.match(PLUGIN_CONFIG_RE);
  if (!match) return null;
  const pluginName = (match[1] || match[2]).toLowerCase();
  const params = PLUGIN_PARAMS[pluginName];
  if (!params) return null;

  const displayName = pluginName.charAt(0).toUpperCase() + pluginName.slice(1);
  const elements: Record<string, unknown> = {};
  const fieldIds: string[] = [];
  const state: Record<string, string> = { pluginId: pluginName };

  elements.title = {
    type: "Heading",
    props: { level: 3, text: `Configure ${displayName}` },
  };
  elements.sep = { type: "Separator", props: {} };

  for (const param of params) {
    const fid = `f_${param.key}`;
    fieldIds.push(fid);
    state[`config.${param.key}`] = "";
    elements[fid] = {
      type: "Input",
      props: {
        label: param.label,
        placeholder: param.key,
        statePath: `config.${param.key}`,
        type: param.secret ? "password" : "text",
        className: "font-mono text-xs",
      },
    };
  }

  elements.fields = { type: "Stack", props: { gap: "3", children: fieldIds } };
  elements.saveBtn = {
    type: "Button",
    props: {
      text: "Save & Enable",
      variant: "default",
      className: "font-semibold",
      on: {
        press: { action: "plugin:save", params: { pluginId: pluginName } },
      },
    },
  };
  elements.actions = {
    type: "Stack",
    props: { direction: "row", gap: "2", children: ["saveBtn"] },
  };
  elements.root = {
    type: "Card",
    props: {
      children: ["title", "sep", "fields", "actions"],
      className: "p-4 space-y-3",
    },
  };

  const spec = JSON.stringify({ version: 1, root: "root", elements, state });
  return `here's the config form for ${displayName} — fill in your credentials and hit save:\n\n\`\`\`json-render\n${spec}\n\`\`\``;
}

// ---------------------------------------------------------------------------
// Plugin config mutation rejections
// ---------------------------------------------------------------------------

export interface PluginConfigMutationRejection {
  field: string;
  message: string;
}

export function resolvePluginConfigMutationRejections(
  pluginParams: Array<{ key: string }>,
  config: Record<string, unknown>,
): PluginConfigMutationRejection[] {
  const allowedParamKeys = new Set(
    pluginParams.map((p) => p.key.toUpperCase().trim()),
  );
  const rejections: PluginConfigMutationRejection[] = [];

  for (const key of Object.keys(config)) {
    const normalized = key.toUpperCase().trim();

    if (!allowedParamKeys.has(normalized)) {
      rejections.push({
        field: key,
        message: `${key} is not a declared config key for this plugin`,
      });
      continue;
    }

    if (BLOCKED_ENV_KEYS.has(normalized)) {
      rejections.push({
        field: key,
        message: `${key} is blocked for security reasons`,
      });
    }
  }

  return rejections;
}
