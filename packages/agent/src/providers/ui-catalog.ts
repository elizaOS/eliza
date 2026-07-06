/**
 * Dynamic prompt guides for rich UI output, split by cost and intent (#14324):
 * `uiWidgets` teaches the closed in-chat marker vocabulary ([CONFIG:pluginId],
 * [CHOICE], [FOLLOWUPS], [FORM], [CHECKLIST], [WORKFLOW]) in a hard-budgeted ~60 lines,
 * while `uiGenerative` carries the expensive generative-UI method (inline RFC
 * 6902 JSONL patches + the ~156-component catalog) behind narrower
 * dashboard/table/visualization relevance keywords. Both are `dynamic: true`
 * (excluded from default state composition) and DM/API-channel gated; the
 * heavier generative guide also stays ADMIN-gated. The split keeps everyday
 * widget guidance cheap and stops the JSONL method from steering the model when
 * the user only wants a plugin set up; `ui-widgets.budget.test.ts` enforces the
 * size ceiling.
 *
 * Discovery: on the live v5 chat path, dynamic providers reach the planner
 * prompt when their contextGate matches the turn's Stage-1 contexts
 * (selectV5PlannerStateProviderNames → composeState onlyInclude) — the
 * request-by-name loop (PROVIDERS advertisement → Content.providers) is
 * currently unreachable there, so `description` is model-invisible on that
 * path (kept for the legacy composeState path and any future re-wiring).
 * `relevanceKeywords` is advisory metadata no selection engine consumes; the
 * *enforced* intent gate for the expensive catalog is the in-get check on
 * `uiGenerative` (the plugin-manager precedent): word-boundary keyword
 * matching over the message + recent history (bare substring matching fired
 * on "paragraph"/"comfortable"), OR-ed with a continuation signal — recent
 * JSONL patch output keeps the guide alive while the user iterates on a
 * rendered UI after the intent keywords scroll out of the history window.
 * `uiWidgets` is context-gated to the Stage-1 contexts its markers serve
 * (general/tasks/todos/productivity/connectors/settings). Gating it on the
 * old general-only context silenced [FORM] guidance on scheduling turns and
 * [CONFIG] guidance on connector setup turns. uiWidgets' constant text is
 * cacheable per-agent; uiGenerative's output varies per turn, so it must not
 * declare cacheStable.
 */
import {
  ChannelType,
  getRecentMessagesData,
  type IAgentRuntime,
  logger,
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

/** Marker guides render inline in chat surfaces only — never on group/feed channels. */
function isAllowedChannel(message: Memory): boolean {
  const channelType = message.content.channelType;
  return (
    channelType === ChannelType.DM ||
    channelType === ChannelType.API ||
    !channelType
  );
}

/**
 * The canonical marker vocabulary. Grammar examples are load-bearing: the
 * followups/form blocks must keep matching the UI parsers exactly
 * (`ui-catalog.followups.test.ts` pins them against the parser regexes), and
 * the budget test caps this text so it cannot silently regrow.
 */
export const UI_WIDGETS_GUIDE = `## In-chat widgets — canonical markers you can emit in replies

### [CONFIG:pluginId] — plugin configuration card
Emit EXACTLY this marker whenever a plugin comes up in setup/config/status
(e.g. [CONFIG:discord], [CONFIG:openai]). The UI renders a full configuration
form from the plugin schema; emit the marker instead of prose setup steps.

### [FOLLOWUPS] — 2–4 tappable next steps (optional)
Use ONLY when a follow-up genuinely helps. Emit INLINE, one
\`<kind>:<payload>=<label>\` per line:
[FOLLOWUPS]
reply:Summarize my unread messages=Summarize unread
navigate:/apps/tasks=View tasks
prompt:Draft a reply about =Draft a reply
[/FOLLOWUPS]
Kinds: reply sends <payload>; navigate opens a "/" route or view id; prompt
prefills the composer. Labels 1–4 words. Omit when no useful next step exists.

### [CHOICE:<scope>] — pick one from concrete options
Use when 2+ explicit choices remove typing or ambiguity. Emit one
\`<value>=<label>\` per line; tapped value is sent as the user's next message:
[CHOICE:approval id=req_123]
Approve request req_123=Approve
Reject request req_123=Deny
[/CHOICE]

### [FORM] — collect several specific values at once
Render a form instead of asking in prose when a tool needs 2+ missing fields.
Emit INLINE; body is one JSON object on its own line between the markers:
[FORM]
{"title":"Schedule reminder","submitLabel":"Create","fields":[{"name":"title","type":"text","label":"Reminder","required":true},{"name":"when","type":"datetime","label":"When","required":true},{"name":"channel","type":"select","label":"Notify via","options":[{"label":"Push","value":"push"},{"label":"Email","value":"email"}]}]}
[/FORM]
Field types: text | number | select (needs options) | checkbox | date | time |
datetime. Prefer date/time/datetime for schedules. Field names start with a
letter. NEVER use [FORM] for secrets or API keys; use the secure secret flow.
For one free-text answer, just ask.

### [CHECKLIST] — live todo list while you work through steps
[CHECKLIST]
{"title":"Migration","items":[{"content":"Back up the database","status":"completed"},{"content":"Run the migration","status":"in_progress"},{"content":"Verify downstream consumers","status":"pending"}]}
[/CHECKLIST]
Item status: pending | in_progress | completed. Re-emit the WHOLE block with
updated statuses. A coding/orchestrator task surfaces its own plan.

### [WORKFLOW] — ordered k/N step pipeline
[WORKFLOW]
{"title":"Deploy","steps":[{"label":"Build image","status":"done"},{"label":"Push to registry","status":"running"},{"label":"Roll out","status":"pending"}]}
[/WORKFLOW]
Step status: pending | running | done | failed. Re-emit to advance. [WORKFLOW]
is ordered; [CHECKLIST] is unordered.

### When to use
- Plugin setup/status → [CONFIG:pluginId], always
- Pick one → [CHOICE]; several values → [FORM]; next steps → [FOLLOWUPS]
- Your own multi-step work → [CHECKLIST] (unordered) / [WORKFLOW] (ordered)
- Custom dashboards/tables/charts → separate generative-UI guide; facts → text`;

/**
 * Everyday marker guidance — cheap, always the first thing the model learns
 * about rich output, including response turns that bypass dynamic selection.
 */
export const uiWidgetsProvider: Provider = {
  name: "uiWidgets",
  description:
    "How to render in-chat widgets: plugin config cards, forms with native date/time pickers, follow-up chips, checklists, and step pipelines",
  dynamic: true,
  alwaysInResponseState: true,
  relevanceKeywords: getValidationKeywordTerms("provider.uiWidgets.relevance", {
    includeAllLocales: true,
  }),
  // The v5 planner filters dynamic providers by exact Stage-1 contexts, with
  // no ancestor expansion. A scheduling turn can select `tasks`, while plugin
  // setup selects `connectors`/`settings`; `general` alone misses the guide's
  // flagship marker use cases.
  contexts: [
    "general",
    "tasks",
    "todos",
    "productivity",
    "connectors",
    "settings",
  ],
  contextGate: {
    anyOf: [
      "general",
      "tasks",
      "todos",
      "productivity",
      "connectors",
      "settings",
    ],
  },
  cacheStable: true,
  cacheScope: "agent",

  get: async (_runtime: IAgentRuntime, message: Memory, _state: State) => {
    if (!isAllowedChannel(message)) {
      return { text: "" };
    }
    logger.debug(
      { src: "agent:uiWidgets", chars: UI_WIDGETS_GUIDE.length },
      "[uiWidgets] injected marker vocabulary guide",
    );
    return { text: UI_WIDGETS_GUIDE };
  },
};

const escapeRegex = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Word-boundary keyword test. `\b` anchors only work for ASCII word chars,
 * so CJK/word-boundary-less terms fall back to substring matching — for the
 * ASCII terms this is what stops "paragraph" firing "graph" and
 * "comfortable" firing "table" (see plugin-manager's buildKeywordRegex).
 */
function matchesKeywords(
  texts: string[],
  keywords: readonly string[],
): boolean {
  if (keywords.length === 0) return false;
  const ascii = keywords.filter((k) => /^[\w\s-]+$/.test(k));
  const other = keywords.filter((k) => !/^[\w\s-]+$/.test(k));
  const regex =
    ascii.length > 0
      ? new RegExp(`\\b(?:${ascii.map(escapeRegex).join("|")})\\b`, "i")
      : null;
  return texts.some((text) => {
    if (!text) return false;
    if (regex?.test(text)) return true;
    const lower = text.toLowerCase();
    return other.some((k) => lower.includes(k.toLowerCase()));
  });
}

// A rendered generative UI is iterated over many turns; once the intent
// keywords scroll out of the history window, the agent's own emitted JSONL
// patches are the signal that the guide is still needed.
const JSONL_PATCH_RE = /"op"\s*:\s*"(?:add|replace|remove)"/;

/**
 * The generative-UI escape hatch: inline JSONL patches + the component
 * catalog. Fires only on dashboard/table/visualization intent so its ~150
 * lines never tax a plugin-setup or scheduling turn.
 */
// Shared by the provider metadata and its own get() intent gate, so the gate
// never has to reach back through the optional Provider field.
const GENERATIVE_INTENT_KEYWORDS = getValidationKeywordTerms(
  "provider.uiGenerative.relevance",
  { includeAllLocales: true },
);

export const uiGenerativeProvider: Provider = {
  name: "uiGenerative",
  description:
    "How to render custom dashboards, tables, charts, and metrics views as generative UI (JSONL patches + component catalog)",
  dynamic: true,
  relevanceKeywords: GENERATIVE_INTENT_KEYWORDS,
  contexts: ["general"],
  contextGate: { anyOf: ["general"] },
  // Renders after uiWidgets (markers-first); composeState orders by
  // (position || 0) then name, and "uiGenerative" sorts before "uiWidgets".
  position: 1,
  // ADMIN-gated: the declared roleGate is enforced by applyPluginRoleGating.
  roleGate: { minRole: "ADMIN" },

  get: async (_runtime: IAgentRuntime, message: Memory, state: State) => {
    if (!isAllowedChannel(message)) {
      return { text: "" };
    }
    // Enforced intent gate: the ~150-line catalog emits only when the turn
    // (or recent history) shows dashboard/table/visualization intent, or a
    // generative UI is already mid-iteration (recent JSONL patches). This is
    // the sole guard on the hot path — the v5 planner composes context-gated
    // dynamic providers on every general ADMIN turn.
    const keywords = GENERATIVE_INTENT_KEYWORDS;
    const texts = [
      message.content.text ?? "",
      ...getRecentMessagesData(state).map((m) => m.content.text ?? ""),
    ];
    const intent = matchesKeywords(texts, keywords);
    const iterating = texts.some((t) => JSONL_PATCH_RE.test(t));
    if (!intent && !iterating) {
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

    const text = `## Generative UI — inline JSONL patches (custom dashboards, tables, visualisations)
Use this ONLY for a custom table, metrics view, dashboard, or visualisation.
For plugin setup use [CONFIG:pluginId]; for a quick fixed-field form use
[FORM]; both are described in the in-chat widgets guide — never hand-build
those here.

Emit RFC 6902 JSON patch lines INLINE in your response (no code fences, no markdown):
{"op":"add","path":"/root","value":"card-1"}
{"op":"add","path":"/elements/card-1","value":{"type":"Card","props":{"title":"Weekly report"},"children":["body-1"]}}
{"op":"add","path":"/elements/body-1","value":{"type":"Text","props":{"text":"Numbers below."},"children":[]}}

Rules:
- Always emit /root first, then /elements/<id>, then /state/<key>
- Each patch must be on its own line, valid JSON, no trailing text on that line
- Element IDs: unique kebab-case strings
- state binding: set statePath prop on Input/Select/Textarea to a dot-path key
- data binding in props: "$data.key.path" resolves from state at render time

### Available components (${Object.keys(COMPONENT_CATALOG).length} total)
${componentLines.join("\n")}`;

    logger.debug(
      { src: "agent:uiGenerative", chars: text.length },
      "[uiGenerative] injected generative-UI catalog guide",
    );
    return { text };
  },
};
