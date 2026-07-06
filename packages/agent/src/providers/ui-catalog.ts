/**
 * Two dynamic providers that teach the agent how to render interactive UI in
 * chat replies, split so the common path stays cheap:
 *
 * - `uiWidgetsProvider` ("uiWidgets") injects only the closed marker vocabulary
 *   the MVP relies on — `[CONFIG:pluginId]`, `[FOLLOWUPS]`, `[FORM]`,
 *   `[CHECKLIST]`, `[WORKFLOW]` — which the parser (`parseSegments`) and the
 *   inline widget registry render directly. This is the path plugin-setup and
 *   scheduling intents take, so it must not steer the model toward raw JSONL.
 * - `uiGenerativeProvider` ("uiGenerative") injects the heavier generative-UI
 *   escape hatch (inline RFC 6902 JSONL patches) plus the shared component
 *   catalog summary. It fires only on data-visualisation intent (dashboards,
 *   tables, charts) so its ~150 lines are spent only when GenUI is actually
 *   wanted.
 *
 * Both emit only on DM/API/unset channels, sit behind the same ADMIN role gate,
 * are `dynamic: true` (excluded from default state composition — see
 * `packages/core/src/runtime.ts`), and are cached per-agent since their text is
 * static. Splitting the guide is what keeps the marker path off the GenUI text;
 * do not fold them back together.
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

// Core components described in detail in the generative catalog — a subset kept
// short so the generative guide stays bounded even as the catalog grows.
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

// Shared gate: the model-facing UI guides only make sense on the dashboard-style
// surfaces (DM/API/unset). Connector group channels never see marker text.
function isGuideChannel(message: Memory): boolean {
  const channelType = message.content.channelType;
  return (
    channelType === ChannelType.DM ||
    channelType === ChannelType.API ||
    !channelType
  );
}

// The closed marker vocabulary: rendered by the inline widget registry from
// action-emitted or model-emitted markers at zero catalog cost. Leading with
// these (instead of JSONL) is the point of the split.
const WIDGETS_GUIDE = `## Chat widgets — render interactive UI with inline markers

Prefer these canonical markers over prose. Each renders in place; emit INLINE with no code fences.

### [CONFIG:pluginId] — plugin configuration form
Emit EXACTLY \`[CONFIG:pluginId]\` (short plugin ID, e.g. [CONFIG:discord], [CONFIG:openai], [CONFIG:polymarket]) whenever a plugin is named for setup, status, or configuration. The UI generates the full config form from the plugin schema. Do NOT describe setup steps in prose — emit the marker and stop.
Use it when: the user names a plugin; asks to show / set up / configure / enable / install a plugin; or you would otherwise say "you need to configure X".

### [FORM] — collect several values at once
When you need multiple specific values, render a form instead of asking in prose. Body is one JSON line between the markers:
[FORM]
{"title":"Schedule reminder","submitLabel":"Create","fields":[{"name":"title","type":"text","label":"Reminder","required":true},{"name":"when","type":"datetime","label":"When","required":true},{"name":"channel","type":"select","label":"Notify via","options":[{"label":"Push","value":"push"},{"label":"Email","value":"email"}]}]}
[/FORM]
Field types: text | number | select (needs options) | checkbox | date | time | datetime. Use date/time/datetime for any scheduling input — they render native pickers and return local values, so never collect a date/time as free text. Field "name" must start with a letter; submitted values come back as a normal message. Do NOT use [FORM] for secrets or API keys (those use the secure secret flow), and do NOT use it for a single free-text answer — just ask.

### [FOLLOWUPS] — suggested next-step chips (optional)
End a reply with 2–4 tappable next steps ONLY when a follow-up genuinely helps — never to pad. One \`<kind>:<payload>=<label>\` per line:
[FOLLOWUPS]
reply:Summarize my unread messages=Summarize unread
navigate:/apps/tasks=View tasks
prompt:Draft a reply about =Draft a reply
[/FOLLOWUPS]
Kinds: reply (sends payload as the next message) · navigate (payload is a route like /apps/tasks) · prompt (prefills the composer). Keep labels 1–4 words; omit the block when no useful follow-up exists.

### [CHECKLIST] / [WORKFLOW] — live progress in place
Track multi-step work with a widget instead of narrating. Body is one JSON line between the markers; re-emit the whole block with advanced statuses to mutate it in place.
[CHECKLIST]
{"title":"Migration","items":[{"content":"Back up the database","status":"completed"},{"content":"Run the migration","status":"in_progress"},{"content":"Verify downstream consumers","status":"pending"}]}
[/CHECKLIST]
[WORKFLOW]
{"title":"Deploy","steps":[{"label":"Build image","status":"done"},{"label":"Push to registry","status":"running"},{"label":"Roll out","status":"pending"}]}
[/WORKFLOW]
Checklist item status: pending | in_progress | completed (unordered todos). Workflow step status: pending | running | done | failed (ordered k/N pipeline). A coding/orchestrator task surfaces its own plan — do not duplicate it with a [CHECKLIST].

For a table, dashboard, metrics view, or other custom layout, generative UI is available separately.`;

export const uiWidgetsProvider: Provider = {
  name: "uiWidgets",
  dynamic: true,
  relevanceKeywords: getValidationKeywordTerms("provider.uiWidgets.relevance", {
    includeAllLocales: true,
  }),
  contexts: ["general"],
  contextGate: { anyOf: ["general"] },
  cacheStable: true,
  cacheScope: "agent",
  // ADMIN-gated: the declared roleGate is enforced by applyPluginRoleGating.
  roleGate: { minRole: "ADMIN" },

  get: async (_runtime: IAgentRuntime, message: Memory, _state: State) => {
    if (!isGuideChannel(message)) {
      return { text: "" };
    }
    return { text: WIDGETS_GUIDE };
  },
};

export const uiGenerativeProvider: Provider = {
  name: "uiGenerative",
  dynamic: true,
  relevanceKeywords: getValidationKeywordTerms(
    "provider.uiGenerative.relevance",
    { includeAllLocales: true },
  ),
  contexts: ["general"],
  contextGate: { anyOf: ["general"] },
  cacheStable: true,
  cacheScope: "agent",
  // ADMIN-gated: the declared roleGate is enforced by applyPluginRoleGating.
  roleGate: { minRole: "ADMIN" },

  get: async (_runtime: IAgentRuntime, message: Memory, _state: State) => {
    if (!isGuideChannel(message)) {
      return { text: "" };
    }

    // Component summary — detailed for the core set, brief for the rest.
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
      text: `## Generative UI — build a custom layout with inline JSONL patches

Escape hatch for tables, dashboards, and visualisations that the canonical widget markers can't express. For plugin config, forms, followups, or progress, use those markers instead — do not rebuild them here.

Emit RFC 6902 JSON patch lines INLINE in your response (no code fences, no markdown):
{"op":"add","path":"/root","value":"card-1"}
{"op":"add","path":"/elements/card-1","value":{"type":"Card","props":{"title":"This Week"},"children":["body-1"]}}
{"op":"add","path":"/elements/body-1","value":{"type":"Text","props":{"text":"Your metrics below."},"children":[]}}

Rules:
- Always emit /root first, then /elements/<id>, then /state/<key>
- Each patch on its own line, valid JSON, no trailing text on that line
- Element IDs: unique kebab-case strings
- State binding: set the statePath prop on Input/Select/Textarea to a dot-path key
- Data binding in props: "$data.key.path" resolves from state at render time

### Available components (${Object.keys(COMPONENT_CATALOG).length} total)
${componentLines.join("\n")}`,
    };
  },
};
