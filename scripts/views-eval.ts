#!/usr/bin/env bun
/**
 * views-eval — real-Cerebras proof + GEPA optimization for the view-switching
 * planner classification.
 *
 * In production the VIEWS action's mode is resolved by deterministic regex
 * (`inferMode`) and view targets by deterministic fuzzy match (`resolveView`).
 * The single LLM surface in the view-switching flow is the PLANNER: given a
 * natural-language utterance it must decide to invoke VIEWS and fill the
 * `action` (mode) + `view` (target) parameters. This harness optimizes exactly
 * that classification.
 *
 * The metric is HARD, not a fuzzy judge: a model output scores 1.0 only if it
 * emits parseable JSON whose `action` is the canonical VIEWS mode for the
 * utterance AND (when the utterance names a target) its `view` resolves to the
 * expected view through the SAME fuzzy matcher the live action uses. Partial
 * credit (0.5 right shape/wrong mode, 0.85 right mode/wrong target) gives GEPA a
 * gradient.
 *
 * Two modes:
 *   proof  (default) — run the baseline prompt over the scenario set once and
 *                      report the routing accuracy. Real-LLM e2e proof.
 *   gepa             — reflective prompt optimization: score the baseline,
 *                      diagnose failures, generate candidate system prompts,
 *                      keep the best. Exports the winner.
 *
 * Usage:
 *   CEREBRAS_API_KEY=csk-... bun run scripts/views-eval.ts            # proof
 *   CEREBRAS_API_KEY=csk-... bun run scripts/views-eval.ts --gepa     # optimize
 *
 * Env mirrors homescreen-eval: CEREBRAS_API_KEY (required), CEREBRAS_MODEL
 * (gpt-oss-120b), VIEWS_GENERATIONS (3), VIEWS_CANDIDATES (3), VIEWS_EXPORT_DIR,
 * VIEWS_DEBUG.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// ── Config ────────────────────────────────────────────────────────────────

const API_KEY = process.env.CEREBRAS_API_KEY ?? "";
const MODEL = process.env.CEREBRAS_MODEL ?? "gpt-oss-120b";
const BASE_URL = process.env.CEREBRAS_BASE_URL ?? "https://api.cerebras.ai/v1";
const GENERATIONS = Number.parseInt(process.env.VIEWS_GENERATIONS ?? "3", 10);
const CANDIDATES = Number.parseInt(process.env.VIEWS_CANDIDATES ?? "3", 10);
const EXPORT_DIR =
  process.env.VIEWS_EXPORT_DIR ?? `/tmp/views-eval-${Date.now()}`;
const GEPA = process.argv.includes("--gepa");
const MAX_SCENARIOS = Number.parseInt(
  process.env.VIEWS_MAX_SCENARIOS ?? "0",
  10,
);
const COUNT_SCENARIOS = process.argv.includes("--count-scenarios");
const VALIDATE_SCENARIOS = process.argv.includes("--validate-scenarios");

// ── Cerebras client with backoff (the key is rate-limited; 429s are common) ──

interface ChatMessage {
  role: "system" | "user";
  content: string;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

// Minimum spacing between request *starts* so we stay under the per-minute
// quota instead of stampeding into 429s. The key is shared and tightly
// throttled, so pacing — not retrying — is the real fix.
const MIN_INTERVAL_MS = Number.parseInt(
  process.env.CEREBRAS_MIN_INTERVAL_MS ?? "1500",
  10,
);
// How long a single call may spend backing off before it gives up. Big enough
// to ride out a full quota window (a 60s RPM bucket) even under contention.
const BACKOFF_BUDGET_MS = Number.parseInt(
  process.env.CEREBRAS_BACKOFF_BUDGET_MS ?? "180000",
  10,
);

// Serialize every Cerebras call through one chain and space the starts. This
// guarantees at most one in-flight request and a steady cadence, which is what
// keeps us under the rate limit rather than relying on backoff alone.
let cerebrasChain: Promise<unknown> = Promise.resolve();
let lastStart = 0;
function gate<T>(fn: () => Promise<T>): Promise<T> {
  const run = cerebrasChain.then(async () => {
    const since = Date.now() - lastStart;
    if (since < MIN_INTERVAL_MS) await sleep(MIN_INTERVAL_MS - since);
    lastStart = Date.now();
    return fn();
  });
  cerebrasChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function cerebras(
  messages: ChatMessage[],
  temperature: number,
  maxTokens: number,
): Promise<string> {
  const body = {
    model: MODEL,
    messages,
    temperature,
    max_tokens: maxTokens,
    stream: false,
  };
  return gate(async () => {
    let attempt = 0;
    let waited = 0;
    for (;;) {
      const res = await fetch(`${BASE_URL}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${API_KEY}`,
        },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        const json = (await res.json()) as {
          choices?: Array<{ message?: { content?: string } }>;
        };
        return json.choices?.[0]?.message?.content ?? "";
      }
      if (res.status === 429 && waited < BACKOFF_BUDGET_MS) {
        // Honor the server's Retry-After when present, else exponential
        // backoff; add jitter so concurrent jobs don't resync their retries.
        const retryAfter = Number.parseInt(
          res.headers.get("retry-after") ?? "",
          10,
        );
        const headerWait = Number.isFinite(retryAfter) ? retryAfter * 1000 : 0;
        const backoff = Math.min(2000 * 2 ** attempt, 30_000);
        const wait =
          Math.max(headerWait, backoff) + Math.floor(Math.random() * 500);
        attempt += 1;
        waited += wait;
        console.log(
          `  · 429 rate-limited, backing off ${wait}ms (try ${attempt}, ${Math.round(waited / 1000)}s total)`,
        );
        await sleep(wait);
        continue;
      }
      throw new Error(
        `Cerebras ${res.status}: ${(await res.text()).slice(0, 300)}`,
      );
    }
  });
}

// ── View catalog the planner reasons over (mirrors a real install) ───────────

interface ViewCatalogEntry {
  id: string;
  label: string;
  path: string;
  keywords: string[];
}

const VIEW_CATALOG: ViewCatalogEntry[] = [
  { id: "chat", label: "Chat", path: "/", keywords: ["home", "conversation"] },
  {
    id: "wallet.inventory",
    label: "Wallet",
    path: "/wallet",
    keywords: ["crypto", "finance", "balance", "tokens"],
  },
  {
    id: "settings",
    label: "Settings",
    path: "/settings",
    keywords: ["preferences", "config"],
  },
  {
    id: "lifeops",
    label: "LifeOps",
    path: "/lifeops",
    keywords: ["tasks", "habits", "planner"],
  },
  {
    id: "calendar",
    label: "Calendar",
    path: "/calendar",
    keywords: ["schedule", "meetings", "agenda", "events"],
  },
  {
    id: "mail",
    label: "Mail",
    path: "/mail",
    keywords: ["email", "inbox", "messages"],
  },
  {
    id: "files",
    label: "Files",
    path: "/files",
    keywords: ["documents", "uploads", "drive"],
  },
  {
    id: "health",
    label: "Health",
    path: "/health",
    keywords: ["fitness", "sleep", "meds", "symptoms"],
  },
  {
    id: "browser",
    label: "Browser",
    path: "/browser",
    keywords: ["web", "tabs", "internet"],
  },
  {
    id: "media",
    label: "Media",
    path: "/media",
    keywords: ["music", "video", "playlist"],
  },
  {
    id: "memory",
    label: "Memory",
    path: "/memory",
    keywords: ["facts", "profile", "remembered"],
  },
  {
    id: "automations",
    label: "Automations",
    path: "/automations",
    keywords: ["workflows", "triggers", "routines"],
  },
];

// Expose each view's aliases (keywords) too — the grader resolves targets via
// these (e.g. "home" → chat), so the model must see the same signal it is
// judged on, otherwise alias-only utterances are unwinnable.
const CATALOG_TEXT = VIEW_CATALOG.map(
  (v) =>
    `  - id="${v.id}" label="${v.label}" path="${v.path}" aliases=[${v.keywords
      .map((k) => `"${k}"`)
      .join(", ")}]`,
).join("\n");

/**
 * Deterministic target resolver — the eval oracle. Mirrors the spirit of the
 * live `resolveView` fuzzy match: id/label exact, else keyword/substring.
 * Returns the canonical view id or null.
 */
function resolveTarget(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const q = raw.trim().toLowerCase();
  if (!q) return null;
  for (const v of VIEW_CATALOG) {
    if (v.id.toLowerCase() === q || v.label.toLowerCase() === q) return v.id;
  }
  for (const v of VIEW_CATALOG) {
    if (
      v.label.toLowerCase().includes(q) ||
      q.includes(v.label.toLowerCase()) ||
      v.keywords.some((k) => q.includes(k))
    ) {
      return v.id;
    }
  }
  return null;
}

// ── Scenarios — utterance + the routing it must produce ──────────────────────

type ViewsMode =
  | "list"
  | "current"
  | "show"
  | "search"
  | "manager"
  | "broadcast"
  | "interact"
  | "create"
  | "edit"
  | "delete"
  | "pin"
  | "window";

interface Scenario {
  id: string;
  utterance: string;
  mode: ViewsMode;
  /** Canonical view id the utterance targets, when it names one. */
  target?: string;
}

const BASE_SCENARIOS: Scenario[] = [
  { id: "list", utterance: "what views are available?", mode: "list" },
  {
    id: "show-wallet",
    utterance: "open the wallet view",
    mode: "show",
    target: "wallet.inventory",
  },
  {
    id: "switch-settings",
    utterance: "switch to settings",
    mode: "show",
    target: "settings",
  },
  {
    id: "go-to-lifeops",
    utterance: "go to my habits and tasks screen",
    mode: "show",
    target: "lifeops",
  },
  {
    id: "search-finance",
    utterance: "search views for anything finance related",
    mode: "search",
  },
  {
    id: "manager",
    utterance: "open the view manager",
    mode: "manager",
  },
  {
    id: "current",
    utterance: "what view am I currently on?",
    mode: "current",
  },
  {
    id: "broadcast-refresh",
    utterance: "tell the wallet view to refresh its data",
    mode: "broadcast",
    target: "wallet.inventory",
  },
  {
    id: "interact-click",
    utterance: "click the submit button in the settings view",
    mode: "interact",
    target: "settings",
  },
  {
    id: "create",
    utterance: "create a new view for tracking my workouts",
    mode: "create",
  },
  {
    id: "edit-wallet",
    utterance: "edit the wallet view to add a chart",
    mode: "edit",
    target: "wallet.inventory",
  },
  {
    id: "delete-lifeops",
    utterance: "delete the LifeOps plugin",
    mode: "delete",
    target: "lifeops",
  },
  {
    id: "pin-wallet",
    utterance: "pin the wallet view as a desktop tab",
    mode: "pin",
    target: "wallet.inventory",
  },
  {
    id: "window-settings",
    utterance: "open settings in a separate window",
    mode: "window",
    target: "settings",
  },
  // ── Adversarial: ambiguous boundaries that trip naive classifiers ──────────
  // "apps" is the manager surface, not a single view to show.
  { id: "adv-all-apps", utterance: "show me all my apps", mode: "manager" },
  // Keyword query with no single named view → search, not show.
  {
    id: "adv-keyword-search",
    utterance: "look for any views related to crypto",
    mode: "search",
  },
  // "close/dismiss this view" routes to the manager surface.
  {
    id: "adv-close",
    utterance: "close this view and take me back",
    mode: "manager",
  },
  // Semantic navigation with NO "view" noun — must still map to show + target.
  {
    id: "adv-semantic-show",
    utterance: "I want to check my crypto balance",
    mode: "show",
    target: "wallet.inventory",
  },
  // "take me home" → show the chat/home view.
  {
    id: "adv-home",
    utterance: "take me home",
    mode: "show",
    target: "chat",
  },
  // Refresh with no "view" noun is still a broadcast to the named view.
  {
    id: "adv-refresh-bare",
    utterance: "refresh my wallet",
    mode: "broadcast",
    target: "wallet.inventory",
  },
  // "read the state of" an element is interact (get-state), not broadcast.
  {
    id: "adv-read-state",
    utterance: "read the current state of the settings panel",
    mode: "interact",
    target: "settings",
  },
];

const scenario = (
  id: string,
  utterance: string,
  mode: ViewsMode,
  target?: string,
): Scenario => ({
  id,
  utterance,
  mode,
  ...(target ? { target } : {}),
});

const targetViews = [
  { id: "chat", aliases: ["home", "chat", "conversation", "main screen"] },
  {
    id: "wallet.inventory",
    aliases: ["wallet", "crypto", "tokens", "balance"],
  },
  {
    id: "settings",
    aliases: ["settings", "preferences", "config", "account controls"],
  },
  { id: "lifeops", aliases: ["lifeops", "habits", "tasks", "planner"] },
  { id: "calendar", aliases: ["calendar", "schedule", "meetings", "agenda"] },
  { id: "mail", aliases: ["mail", "email", "inbox", "messages"] },
  { id: "files", aliases: ["files", "documents", "uploads", "drive"] },
  { id: "health", aliases: ["health", "fitness", "sleep", "meds"] },
  { id: "browser", aliases: ["browser", "web", "tabs", "internet"] },
  { id: "memory", aliases: ["memory", "facts", "profile", "remembered facts"] },
] as const;

const expandedShow = targetViews.flatMap((view) => [
  scenario(
    `edge-show-${view.id}-open`,
    `open ${view.aliases[0]}`,
    "show",
    view.id,
  ),
  scenario(
    `edge-show-${view.id}-go`,
    `go to the ${view.aliases[1]} view`,
    "show",
    view.id,
  ),
  scenario(
    `edge-show-${view.id}-semantic`,
    `I need to check my ${view.aliases[2]}`,
    "show",
    view.id,
  ),
  scenario(
    `edge-show-${view.id}-switch`,
    `switch over to ${view.aliases[3]}`,
    "show",
    view.id,
  ),
]);

const expandedSearch = [
  "find any views related to invoices",
  "search views for project planning",
  "look for a view about travel",
  "show me views matching customer support",
  "search the app list for research tools",
  "find anything connected to photos",
  "look up views for code review",
  "search for views about groceries",
  "what views mention privacy",
  "find a view category for legal docs",
  "search views for anything about podcasts",
  "look for all views connected to personal finance",
  "find tools related to calendar invites",
  "search the view catalog for recipes",
  "look for a dashboard about shipping",
  "find any view that deals with notifications",
  "search for something about subscriptions",
  "which views are useful for writing",
  "look for views related to reminders",
  "find views for debugging automations",
  "search views around social accounts",
  "look for a view that can handle PDFs",
  "find tools for trip packing",
  "search the catalog for voice settings",
  "which installed views mention banking",
].map((utterance, index) =>
  scenario(
    `edge-search-${String(index + 1).padStart(2, "0")}`,
    utterance,
    "search",
  ),
);

const expandedManager = [
  "show all installed apps",
  "open the app drawer",
  "take me to the plugins overview",
  "where can I manage views",
  "close the current view and show the app manager",
  "show the view marketplace",
  "open the screen with every plugin",
  "let me rearrange my views",
  "show me the view admin panel",
  "open all-apps",
  "take me back to the launcher",
  "show installed extensions",
  "open the panel for enabling and disabling views",
  "bring up the view management surface",
  "show me every app I have",
].map((utterance, index) =>
  scenario(
    `edge-manager-${String(index + 1).padStart(2, "0")}`,
    utterance,
    "manager",
  ),
);

const expandedListCurrent = [
  scenario(
    "edge-list-capabilities",
    "which views can you open for me?",
    "list",
  ),
  scenario("edge-list-short", "views?", "list"),
  scenario("edge-list-installed", "list installed views", "list"),
  scenario("edge-list-available-tabs", "what tabs are available", "list"),
  scenario(
    "edge-list-plugin-surfaces",
    "name the plugin screens I can use",
    "list",
  ),
  scenario(
    "edge-list-without-opening",
    "tell me the views without opening anything",
    "list",
  ),
  scenario(
    "edge-list-after-confusion",
    "wait, what view choices do I have",
    "list",
  ),
  scenario("edge-list-navigation-help", "where can I go in this app", "list"),
  scenario("edge-list-shortcuts", "what screens are in the sidebar", "list"),
  scenario(
    "edge-list-capability-query",
    "what UI surfaces exist right now",
    "list",
  ),
  scenario("edge-current-short", "where am I", "current"),
  scenario("edge-current-active-tab", "which tab is active", "current"),
  scenario(
    "edge-current-view-name",
    "tell me the current view name",
    "current",
  ),
  scenario(
    "edge-current-after-switch",
    "did we switch views already",
    "current",
  ),
  scenario("edge-current-no-target", "what screen is this", "current"),
  scenario("edge-current-location", "what part of the app am I in", "current"),
  scenario("edge-current-status", "report the active view status", "current"),
  scenario("edge-current-route", "what route are we on", "current"),
  scenario("edge-current-visible", "which view is visible", "current"),
  scenario("edge-current-focus", "what view has focus", "current"),
];

const broadcastTargets = [
  ["wallet.inventory", "wallet", "refresh balances"],
  ["wallet.inventory", "crypto", "resync token prices"],
  ["calendar", "calendar", "reload events"],
  ["mail", "inbox", "fetch new mail"],
  ["files", "files", "sync uploads"],
  ["health", "health", "refresh sleep data"],
  ["browser", "browser", "reload the current tab"],
  ["media", "media", "pause playback"],
  ["memory", "memory", "reindex remembered facts"],
  ["automations", "automations", "run due triggers"],
] as const;
const expandedBroadcast = broadcastTargets.flatMap(
  ([target, label, command], index) => [
    scenario(
      `edge-broadcast-${index + 1}-${target}-imperative`,
      `tell ${label} to ${command}`,
      "broadcast",
      target,
    ),
    scenario(
      `edge-broadcast-${index + 1}-${target}-send-event`,
      `send a ${command} event to the ${label} view`,
      "broadcast",
      target,
    ),
    scenario(
      `edge-broadcast-${index + 1}-${target}-bare`,
      `${command} in ${label}`,
      "broadcast",
      target,
    ),
  ],
);

const interactTargets = [
  ["settings", "settings", "toggle dark mode"],
  ["wallet.inventory", "wallet", "press the send button"],
  ["calendar", "calendar", "click next week"],
  ["mail", "mail", "open the first unread message"],
  ["files", "files", "select the latest upload"],
  ["health", "health", "read the medication card"],
  ["browser", "browser", "type into the address bar"],
  ["media", "media", "drag the volume slider down"],
  ["lifeops", "lifeops", "check off the morning habit"],
  ["memory", "memory", "open the profile facts row"],
] as const;
const expandedInteract = interactTargets.flatMap(([target, label, command]) => [
  scenario(
    `edge-interact-${target}-direct`,
    `${command} in ${label}`,
    "interact",
    target,
  ),
  scenario(
    `edge-interact-${target}-inside`,
    `inside the ${label} view, ${command}`,
    "interact",
    target,
  ),
  scenario(
    `edge-interact-${target}-element`,
    `use the ${label} view to ${command}`,
    "interact",
    target,
  ),
]);

const expandedCreate = [
  "create a new view for tracking migraines",
  "build a dashboard view for my rental properties",
  "make a plugin view for weekly meal planning",
  "scaffold a new CRM view",
  "create a view that watches CI deploys",
  "make a new dashboard for livestream controls",
  "create a study planner view",
  "build me a view for household inventory",
  "create a personal OKR tracker view",
  "make a view for monitoring server health",
  "create a new travel itinerary view",
  "build a workout programming view",
  "create a view for client invoices",
  "make a writing sprint view",
  "scaffold a medication log view",
].map((utterance, index) =>
  scenario(
    `edge-create-${String(index + 1).padStart(2, "0")}`,
    utterance,
    "create",
  ),
);

const expandedEdit = [
  ["wallet.inventory", "wallet", "add a profit and loss chart"],
  ["settings", "settings", "add a developer mode toggle"],
  ["lifeops", "lifeops", "add a weekly review panel"],
  ["calendar", "calendar", "show travel time on events"],
  ["mail", "mail", "add a priority inbox column"],
  ["files", "files", "add file type filters"],
  ["health", "health", "add medication reminders"],
  ["browser", "browser", "add a pinned tabs strip"],
  ["memory", "memory", "show source confidence badges"],
  ["automations", "automations", "add failure retry controls"],
  ["media", "media", "add a queue sidebar"],
  ["chat", "home", "make the composer taller"],
  ["wallet.inventory", "crypto dashboard", "add gas fee warnings"],
  ["calendar", "agenda", "add time-zone labels"],
  ["mail", "inbox", "add sender avatars"],
] as const;
const expandedEditScenarios = expandedEdit.map(
  ([target, label, command], index) =>
    scenario(
      `edge-edit-${String(index + 1).padStart(2, "0")}`,
      `edit the ${label} view to ${command}`,
      "edit",
      target,
    ),
);

const expandedDelete = [
  ["lifeops", "remove the habits view"],
  ["wallet.inventory", "delete the crypto dashboard"],
  ["mail", "uninstall the mail view"],
  ["files", "remove the files plugin"],
  ["health", "delete the health dashboard"],
  ["browser", "remove the browser surface"],
  ["media", "uninstall the media view"],
  ["memory", "delete the memory view"],
  ["automations", "remove automations"],
  ["calendar", "delete the calendar view"],
] as const;
const expandedDeleteScenarios = expandedDelete.map(
  ([target, utterance], index) =>
    scenario(
      `edge-delete-${String(index + 1).padStart(2, "0")}`,
      utterance,
      "delete",
      target,
    ),
);

const expandedPinWindow = [
  scenario(
    "edge-pin-calendar",
    "pin calendar as a desktop tab",
    "pin",
    "calendar",
  ),
  scenario("edge-pin-mail", "keep the inbox pinned", "pin", "mail"),
  scenario(
    "edge-pin-browser",
    "pin the browser view beside chat",
    "pin",
    "browser",
  ),
  scenario(
    "edge-pin-health",
    "make health a pinned workspace tab",
    "pin",
    "health",
  ),
  scenario(
    "edge-pin-memory",
    "pin remembered facts for quick access",
    "pin",
    "memory",
  ),
  scenario(
    "edge-window-wallet",
    "open wallet in its own window",
    "window",
    "wallet.inventory",
  ),
  scenario(
    "edge-window-calendar",
    "pop calendar out into a separate window",
    "window",
    "calendar",
  ),
  scenario(
    "edge-window-mail",
    "open the inbox in another window",
    "window",
    "mail",
  ),
  scenario(
    "edge-window-browser",
    "launch browser as a standalone window",
    "window",
    "browser",
  ),
  scenario(
    "edge-window-settings",
    "put settings in a new window",
    "window",
    "settings",
  ),
];

const EXPANDED_SCENARIOS: Scenario[] = [
  ...expandedShow,
  ...expandedSearch,
  ...expandedManager,
  ...expandedListCurrent,
  ...expandedBroadcast,
  ...expandedInteract,
  ...expandedCreate,
  ...expandedEditScenarios,
  ...expandedDeleteScenarios,
  ...expandedPinWindow,
];

if (EXPANDED_SCENARIOS.length !== BASE_SCENARIOS.length * 10) {
  throw new Error(
    `views scenario expansion must add exactly 10x (${BASE_SCENARIOS.length * 10}); got ${EXPANDED_SCENARIOS.length}`,
  );
}

const SCENARIOS: Scenario[] = [...BASE_SCENARIOS, ...EXPANDED_SCENARIOS];
const EVAL_SCENARIOS =
  Number.isFinite(MAX_SCENARIOS) && MAX_SCENARIOS > 0
    ? SCENARIOS.slice(0, MAX_SCENARIOS)
    : SCENARIOS;

if (COUNT_SCENARIOS) {
  console.log(
    JSON.stringify(
      {
        suite: "views",
        existing: BASE_SCENARIOS.length,
        added: EXPANDED_SCENARIOS.length,
        total: SCENARIOS.length,
        multiplierAdded: EXPANDED_SCENARIOS.length / BASE_SCENARIOS.length,
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

if (VALIDATE_SCENARIOS) {
  const ids = new Set<string>();
  const duplicates = SCENARIOS.filter((s) => {
    if (ids.has(s.id)) return true;
    ids.add(s.id);
    return false;
  }).map((s) => s.id);
  const badTargets = SCENARIOS.filter(
    (s) => s.target && resolveTarget(s.target) !== s.target,
  ).map((s) => ({
    id: s.id,
    target: s.target,
    resolved: resolveTarget(s.target),
  }));
  const badModes = SCENARIOS.filter(
    (s) =>
      ![
        "list",
        "current",
        "show",
        "search",
        "manager",
        "broadcast",
        "interact",
        "create",
        "edit",
        "delete",
        "pin",
        "window",
      ].includes(s.mode),
  ).map((s) => s.id);
  if (duplicates.length || badTargets.length || badModes.length) {
    console.error(
      JSON.stringify(
        { suite: "views", duplicates, badTargets, badModes },
        null,
        2,
      ),
    );
    process.exit(1);
  }
  console.log(
    JSON.stringify(
      {
        suite: "views",
        valid: true,
        scenarios: SCENARIOS.length,
        uniqueIds: ids.size,
        targeted: SCENARIOS.filter((s) => s.target).length,
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

if (!API_KEY) {
  console.error("CEREBRAS_API_KEY is required.");
  process.exit(1);
}

// ── Output extraction ────────────────────────────────────────────────────────

interface Routing {
  action?: string;
  view?: string;
}

/** Balanced-brace extraction of the first JSON object (handles prose around). */
function extractJsonObject(raw: string): string | null {
  const start = raw.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < raw.length; i++) {
    const c = raw[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return raw.slice(start, i + 1);
    }
  }
  return null;
}

function parseRouting(raw: string): Routing | null {
  const json = extractJsonObject(raw);
  if (!json) return null;
  try {
    const obj = JSON.parse(json) as Record<string, unknown>;
    const action =
      typeof obj.action === "string"
        ? obj.action
        : typeof obj.mode === "string"
          ? obj.mode
          : undefined;
    const view =
      typeof obj.view === "string"
        ? obj.view
        : typeof obj.target === "string"
          ? obj.target
          : typeof obj.name === "string"
            ? obj.name
            : undefined;
    return { action: action?.trim().toLowerCase(), view };
  } catch {
    return null;
  }
}

// ── Scoring — the hard metric ────────────────────────────────────────────────

interface ScoreDetail {
  scenario: string;
  score: number;
  reason: string;
}

function scoreOutput(scenario: Scenario, raw: string): ScoreDetail {
  const routing = parseRouting(raw);
  if (!routing?.action) {
    return {
      scenario: scenario.id,
      score: 0,
      reason: "no parseable {action} object",
    };
  }
  if (routing.action !== scenario.mode) {
    return {
      scenario: scenario.id,
      score: 0.5,
      reason: `wrong mode: got "${routing.action}", want "${scenario.mode}"`,
    };
  }
  // Mode correct. If the scenario names a target, the view must resolve to it.
  if (scenario.target) {
    const resolved = resolveTarget(routing.view);
    if (resolved !== scenario.target) {
      return {
        scenario: scenario.id,
        score: 0.85,
        reason: `right mode, target "${routing.view ?? "∅"}" → ${resolved ?? "∅"} (want ${scenario.target})`,
      };
    }
  }
  return { scenario: scenario.id, score: 1, reason: "mode + target correct" };
}

// ── Prompt construction ──────────────────────────────────────────────────────

const MODE_GUIDE = [
  'list — enumerate available views ("what views are there")',
  'current — report the currently active view ("what view am I on")',
  "show — navigate to / open / switch to a specific named view",
  "search — find views by keyword when no single view is named",
  "manager — open the view manager / all-apps surface",
  'broadcast — push an event to a mounted view (e.g. "refresh the wallet")',
  "interact — click/tap/fill/read an element inside a mounted view",
  "create — scaffold a brand-new view plugin",
  "edit — modify an existing view plugin",
  "delete — uninstall/remove a view plugin",
  "pin — pin a view as a desktop tab",
  "window — open a view in a separate desktop window",
].join("\n");

function buildUserPrompt(utterance: string): string {
  return [
    "Available views:",
    CATALOG_TEXT,
    "",
    "VIEWS modes:",
    MODE_GUIDE,
    "",
    `User said: "${utterance}"`,
    "",
    'Respond with ONLY a JSON object: {"action": "<mode>", "view": "<view id, label, or descriptive name, omit if none>"}.',
  ].join("\n");
}

const BASELINE_SYSTEM =
  "You route a user's request about UI views to the VIEWS action. Pick exactly " +
  "one mode from the provided list and, when the user names a specific view, " +
  "identify it. Output ONLY the JSON object — no prose, no markdown fence.";

// ── One eval pass over all scenarios with a given system prompt ───────────────

async function evalPass(
  systemPrompt: string,
  label: string,
): Promise<{ mean: number; details: ScoreDetail[] }> {
  const details: ScoreDetail[] = [];
  for (const scenario of EVAL_SCENARIOS) {
    const raw = await cerebras(
      [
        { role: "system", content: systemPrompt },
        { role: "user", content: buildUserPrompt(scenario.utterance) },
      ],
      0.1,
      512,
    );
    const detail = scoreOutput(scenario, raw);
    details.push(detail);
    console.log(
      `  [${label}] ${scenario.id}: ${detail.score.toFixed(2)} — ${detail.reason}`,
    );
    if (process.env.VIEWS_DEBUG && detail.score < 1) {
      console.log(`    raw: ${JSON.stringify(raw.slice(0, 160))}`);
    }
    await sleep(500);
  }
  const mean = details.reduce((a, d) => a + d.score, 0) / details.length;
  return { mean, details };
}

// ── GEPA-style reflective optimization ───────────────────────────────────────

async function reflect(
  systemPrompt: string,
  details: ScoreDetail[],
): Promise<string> {
  const failures = details
    .filter((d) => d.score < 1)
    .map((d) => {
      const sc = SCENARIOS.find((s) => s.id === d.scenario);
      return `- utterance "${sc?.utterance}" (want mode=${sc?.mode}${sc?.target ? `, target=${sc.target}` : ""}): ${d.reason}`;
    })
    .join("\n");
  const user =
    "You are optimizing the SYSTEM PROMPT for a model that classifies a user's " +
    "UI-view request into a VIEWS action mode and target. Current system prompt:\n\n" +
    `"""${systemPrompt}"""\n\n` +
    `These scenarios scored below 1.0:\n${failures || "(none)"}\n\n` +
    "Write an improved system prompt that fixes these failures. It must push the " +
    "model to choose the single correct mode (especially distinguishing show vs " +
    "search vs manager, and broadcast vs interact), extract the named view, and " +
    'emit STRICT JSON {"action","view"} with no prose. Reply with ONLY the new ' +
    "system prompt text.";
  const out = await cerebras(
    [
      {
        role: "system",
        content: "You are a precise prompt engineer. Output only the prompt.",
      },
      { role: "user", content: user },
    ],
    0.7,
    1024,
  );
  return out.trim().replace(/^"+|"+$/g, "");
}

async function runGepa(): Promise<void> {
  console.log(
    `\nGEPA optimization · ${GENERATIONS} generations × ${CANDIDATES} candidates\n`,
  );
  let best = BASELINE_SYSTEM;
  const baseline = await evalPass(best, "baseline");
  let bestScore = baseline.mean;
  let bestDetails = baseline.details;
  console.log(`baseline mean: ${bestScore.toFixed(3)}\n`);

  const lineage: Array<{ gen: number; cand: number; score: number }> = [
    { gen: 0, cand: 0, score: bestScore },
  ];

  for (let gen = 1; gen <= GENERATIONS && bestScore < 1; gen++) {
    for (let cand = 1; cand <= CANDIDATES && bestScore < 1; cand++) {
      const candidate = await reflect(best, bestDetails);
      const pass = await evalPass(candidate, `gen${gen}.${cand}`);
      lineage.push({ gen, cand, score: pass.mean });
      console.log(`gen${gen}.${cand} mean: ${pass.mean.toFixed(3)}\n`);
      if (pass.mean > bestScore) {
        bestScore = pass.mean;
        best = candidate;
        bestDetails = pass.details;
        console.log(`  ★ new best: ${bestScore.toFixed(3)}\n`);
      }
    }
  }

  mkdirSync(EXPORT_DIR, { recursive: true });
  writeFileSync(join(EXPORT_DIR, "views-route-optimized.txt"), best, "utf8");
  writeFileSync(
    join(EXPORT_DIR, "views-route-baseline.txt"),
    BASELINE_SYSTEM,
    "utf8",
  );
  writeFileSync(
    join(EXPORT_DIR, "views-route-report.json"),
    JSON.stringify(
      { model: MODEL, baseline: baseline.mean, best: bestScore, lineage },
      null,
      2,
    ),
    "utf8",
  );
  console.log(
    `\nDone. baseline ${baseline.mean.toFixed(3)} → best ${bestScore.toFixed(3)}`,
  );
  console.log(`Exported to ${EXPORT_DIR}`);
}

async function runProof(): Promise<void> {
  console.log(
    `\nReal-Cerebras proof · model ${MODEL} · ${EVAL_SCENARIOS.length}${EVAL_SCENARIOS.length !== SCENARIOS.length ? `/${SCENARIOS.length}` : ""} scenarios\n`,
  );
  const { mean, details } = await evalPass(BASELINE_SYSTEM, "proof");
  const correct = details.filter((d) => d.score === 1).length;
  const rightMode = details.filter((d) => d.score >= 0.85).length;
  console.log(`\nmean score: ${mean.toFixed(3)}`);
  console.log(`mode correct: ${rightMode}/${details.length}`);
  console.log(`mode + target correct: ${correct}/${details.length}`);
  mkdirSync(EXPORT_DIR, { recursive: true });
  writeFileSync(
    join(EXPORT_DIR, "views-proof-report.json"),
    JSON.stringify({ model: MODEL, mean, details }, null, 2),
    "utf8",
  );
  console.log(`Report: ${join(EXPORT_DIR, "views-proof-report.json")}`);
}

await (GEPA ? runGepa() : runProof());
