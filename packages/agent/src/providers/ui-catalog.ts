import {
  ChannelType,
  type IAgentRuntime,
  type Memory,
  type Provider,
  type State,
} from "@elizaos/core";
import { getValidationKeywordTerms } from "@elizaos/shared";
import { hasAdminAccess } from "../security/access.ts";
import { COMPONENT_CATALOG } from "../shared/ui-catalog-prompt.ts";

// Core components to describe in detail — subset to keep context short.
const DETAIL_COMPONENTS = new Set([
  "Card",
  "Stack",
  "Grid",
  "Text",
  "Button",
  "Input",
  "Select",
  "Textarea",
  "Badge",
  "Metric",
  "Separator",
  "Progress",
  "Table",
  "Alert",
  "Tabs",
]);

export const uiCatalogProvider: Provider = {
  name: "uiCatalog",
  dynamic: true,
  relevanceKeywords: getValidationKeywordTerms("provider.uiCatalog.relevance", {
    includeAllLocales: true,
  }),
  contexts: ["general"],
  contextGate: { anyOf: ["general"] },
  cacheStable: true,
  cacheScope: "agent",
  roleGate: { minRole: "USER" },

  get: async (runtime: IAgentRuntime, message: Memory, _state: State) => {
    const channelType = message.content?.channelType;
    const isAllowedChannel =
      channelType === ChannelType.DM ||
      channelType === ChannelType.API ||
      !channelType;
    if (!isAllowedChannel) {
      return { text: "" };
    }

    if (!(await hasAdminAccess(runtime, message))) {
      return { text: "" };
    }

    // Build component summary — detailed for core set, brief for the rest.
    const componentLines: string[] = [];
    for (const [name, meta] of Object.entries(COMPONENT_CATALOG)) {
      if (DETAIL_COMPONENTS.has(name)) {
        const props = Object.entries(meta.props)
          .map(([k, p]) => `${k}: ${p.type}${p.required ? " (required)" : ""}`)
          .join(", ");
        componentLines.push(
          `- **${name}**: ${meta.description} [props: ${props}]`,
        );
      } else {
        componentLines.push(`- ${name}: ${meta.description}`);
      }
    }

    return {
      text: `## Rich UI Output — you can render interactive components in your replies

### Method 1 — Inline JSONL patches (for custom dashboards, forms, visualisations)
Emit RFC 6902 JSON patch lines INLINE in your response (no code fences, no markdown):
{"op":"add","path":"/root","value":"card-1"}
{"op":"add","path":"/elements/card-1","value":{"type":"Card","props":{"title":"Plugin Setup"},"children":["body-1"]}}
{"op":"add","path":"/elements/body-1","value":{"type":"Text","props":{"text":"Fill in the details below."},"children":[]}}

Rules:
- Always emit /root first, then /elements/<id>, then /state/<key>
- Each patch must be on its own line, valid JSON, no trailing text on that line
- Element IDs: unique kebab-case strings
- state binding: set statePath prop on Input/Select/Textarea to a dot-path key
- data binding in props: "$data.key.path" resolves from state at render time
- Use this method when the user needs a form, table, metrics view, or custom UI

### Method 2 — [CONFIG:pluginId] marker (for plugin configuration forms)
Include EXACTLY this marker whenever a plugin is mentioned in any configuration, setup, or status context:
[CONFIG:pluginId]
Replace pluginId with the plugin's short ID (e.g. [CONFIG:polymarket], [CONFIG:discord], [CONFIG:anthropic], [CONFIG:openai], [CONFIG:twitch]).
The UI will auto-generate a full configuration form from the plugin's parameter schema.

**ALWAYS use [CONFIG:pluginId] when:**
- User mentions a plugin by name ("discord", "polymarket", "openai", etc.)
- User asks to show, view, check, set up, configure, enable, install, or activate a plugin
- You mention that a plugin needs credentials, secrets, or setup steps
- User asks "what plugins", "show me plugins", "check plugin status"
- You would otherwise say "you need to configure X" or "set up X first"

Do NOT describe configuration steps in text — just emit [CONFIG:pluginId] and let the UI handle it.

### When to use rich UI
- Any plugin mentioned by name → Method 2 ([CONFIG:pluginId]) — always
- Forms, data entry, settings panels → Method 1 (JSONL patches with Input/Select)
- Tables, metrics, dashboards → Method 1 (Table/Metric/ProgressBar)
- Simple factual answers with no plugin/form involved → plain text only

### Available components (${Object.keys(COMPONENT_CATALOG).length} total)
${componentLines.join("\n")}`,
    };
  },
};
