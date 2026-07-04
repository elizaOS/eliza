/**
 * Provider that injects the rich-UI authoring guide into the agent prompt: the
 * four output methods (inline RFC 6902 JSONL patches, [CONFIG:pluginId] config
 * forms, [FOLLOWUPS] suggestion chips, [FORM] inline forms) and a summary of the
 * shared component catalog (detailed for a core set, brief for the rest). Emits
 * only on DM/API/unset channels and sits behind an ADMIN role gate; cached
 * per-agent since the catalog is static.
 */
import {
  ChannelType,
  type IAgentRuntime,
  type Memory,
  type Provider,
  type State,
} from "@elizaos/core";
import { getValidationKeywordTerms } from "@elizaos/shared";
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
  // ADMIN-gated: the declared roleGate is enforced by applyPluginRoleGating.
  roleGate: { minRole: "ADMIN" },

  get: async (_runtime: IAgentRuntime, message: Memory, _state: State) => {
    const channelType = message.content.channelType;
    const isAllowedChannel =
      channelType === ChannelType.DM ||
      channelType === ChannelType.API ||
      !channelType;
    if (!isAllowedChannel) {
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

### Method 3 — [FOLLOWUPS] suggestion chips (optional next-step shortcuts)
OPTIONALLY end your reply with 2–4 suggested next steps the user can tap. Use
ONLY when a follow-up is genuinely likely to help — never on every turn, never
to pad a reply. Emit the block INLINE (no code fences), format EXACTLY (literal
newlines, one suggestion per line as \`<kind>:<payload>=<label>\`):
[FOLLOWUPS]
reply:Summarize my unread messages=Summarize unread
navigate:/apps/tasks=View tasks
prompt:Draft a reply about =Draft a reply
[/FOLLOWUPS]
Kinds:
- reply    — sends <payload> as the user's next message (use for a likely follow-up question)
- navigate — switches the app to a view; <payload> is a route path starting with "/"
  (e.g. /apps/tasks, /apps, /automations, /apps/memories, /settings/voice) or a view id.
  Point the user at a relevant surface — e.g. after you create tasks, offer
  \`navigate:/apps/tasks=View tasks\`.
- prompt   — prefills the composer with <payload> so the user can edit before sending
Keep labels short (1–4 words). Omit the block entirely when no useful follow-up exists.

### Method 4 — [FORM] inline form (collect structured input)
When you need several specific values from the user at once, render a form
instead of asking in prose. Emit INLINE (no code fences); body is a JSON object
on its own line between the markers:
[FORM]
{"title":"Schedule reminder","submitLabel":"Create","fields":[{"name":"title","type":"text","label":"Reminder","required":true},{"name":"channel","type":"select","label":"Notify via","options":[{"label":"Push","value":"push"},{"label":"Email","value":"email"}]}]}
[/FORM]
Field types: text | number | select (needs options) | checkbox. Each field "name"
must start with a letter. The user's submitted values come back to you as a normal
message. Do NOT use [FORM] for secrets or API keys (those use the secure secret
flow), and do NOT use it for a single free-text answer — just ask.

### When to use rich UI
- Any plugin mentioned by name → Method 2 ([CONFIG:pluginId]) — always
- Forms, data entry, settings panels → Method 1 (JSONL patches) or Method 4 ([FORM] for a quick fixed-field form)
- Tables, metrics, dashboards → Method 1 (Table/Metric/ProgressBar)
- Helpful next steps after a reply → Method 3 ([FOLLOWUPS]), sparingly
- Simple factual answers with no plugin/form involved → plain text only

### Available components (${Object.keys(COMPONENT_CATALOG).length} total)
${componentLines.join("\n")}`,
    };
  },
};
