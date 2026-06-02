/**
 * View user journey scenario library.
 *
 * A curated collection of realistic user intents for the views system.
 * These scenarios are used for:
 *   1. Manual exploratory testing against a running agent.
 *   2. LLM-in-the-loop automated evaluation (see view-llm-eval.test.ts).
 *   3. Documentation of expected agent behaviors.
 *
 * Each entry is self-contained: it describes the user message, the expected
 * high-level behavior, and machine-checkable verification criteria that an
 * LLM judge or a deterministic assertion can evaluate.
 */

export interface ViewJourneyScenario {
  /** Stable identifier for tooling and reporting. */
  id: string;
  /** One-line description of what the scenario tests. */
  description: string;
  /** The literal message the user sends to the agent. */
  userMessage: string;
  /** Prose description of what a correct agent response looks like. */
  expectedBehavior: string;
  /**
   * Machine-checkable criteria. An LLM judge or assertion can score each.
   * String criteria are evaluated as semantic checks against the agent response.
   */
  verificationCriteria: string[];
  /** Tags for grouping and filtering (e.g. "navigation", "discovery", "error"). */
  tags: string[];
}

export interface PluginViewMockCase {
  id: string;
  viewType: "gui" | "tui" | "xr";
  path: string;
}

export const PLUGIN_VIEW_LLM_MOCK_CASES: PluginViewMockCase[] = [
  { id: "companion", viewType: "gui", path: "/companion" },
  { id: "companion", viewType: "tui", path: "/companion/tui" },
  { id: "contacts", viewType: "gui", path: "/contacts" },
  { id: "contacts", viewType: "tui", path: "/contacts/tui" },
  { id: "hyperliquid", viewType: "gui", path: "/hyperliquid" },
  { id: "hyperliquid", viewType: "tui", path: "/hyperliquid/tui" },
  { id: "lifeops", viewType: "gui", path: "/lifeops" },
  { id: "lifeops", viewType: "tui", path: "/lifeops/tui" },
  { id: "messages", viewType: "gui", path: "/messages" },
  { id: "messages", viewType: "tui", path: "/messages/tui" },
  { id: "model-tester", viewType: "gui", path: "/model-tester" },
  { id: "model-tester", viewType: "tui", path: "/model-tester/tui" },
  { id: "phone", viewType: "gui", path: "/phone" },
  { id: "phone", viewType: "tui", path: "/phone/tui" },
  { id: "polymarket", viewType: "gui", path: "/polymarket" },
  { id: "polymarket", viewType: "tui", path: "/polymarket/tui" },
  { id: "shopify", viewType: "gui", path: "/shopify" },
  { id: "shopify", viewType: "tui", path: "/shopify/tui" },
  { id: "steward", viewType: "gui", path: "/steward" },
  { id: "steward", viewType: "tui", path: "/steward/tui" },
  { id: "vincent", viewType: "gui", path: "/vincent" },
  { id: "vincent", viewType: "tui", path: "/vincent/tui" },
  { id: "wallet", viewType: "gui", path: "/wallet" },
  { id: "wallet", viewType: "tui", path: "/wallet/tui" },
  { id: "2004scape", viewType: "gui", path: "/2004scape" },
  { id: "2004scape", viewType: "tui", path: "/2004scape/tui" },
  { id: "feed", viewType: "gui", path: "/feed" },
  { id: "feed", viewType: "tui", path: "/feed/tui" },
  { id: "views-manager", viewType: "gui", path: "/views" },
  { id: "views-manager", viewType: "tui", path: "/views/tui" },
  { id: "clawville", viewType: "gui", path: "/clawville" },
  { id: "clawville", viewType: "tui", path: "/clawville/tui" },
  {
    id: "defense-of-the-agents",
    viewType: "gui",
    path: "/defense-of-the-agents",
  },
  {
    id: "defense-of-the-agents",
    viewType: "tui",
    path: "/defense-of-the-agents/tui",
  },
  { id: "hyperscape", viewType: "gui", path: "/hyperscape" },
  { id: "hyperscape", viewType: "tui", path: "/hyperscape/tui" },
  { id: "scape", viewType: "gui", path: "/scape" },
  { id: "scape", viewType: "tui", path: "/scape/tui" },
  { id: "screenshare", viewType: "gui", path: "/screenshare" },
  { id: "screenshare", viewType: "tui", path: "/screenshare/tui" },
  { id: "task-coordinator", viewType: "gui", path: "/task-coordinator" },
  { id: "task-coordinator", viewType: "tui", path: "/task-coordinator/tui" },
  { id: "orchestrator", viewType: "gui", path: "/orchestrator" },
  { id: "orchestrator", viewType: "tui", path: "/orchestrator/tui" },
  { id: "trajectory-logger", viewType: "gui", path: "/trajectory-logger" },
  { id: "trajectory-logger", viewType: "tui", path: "/trajectory-logger/tui" },
  { id: "training", viewType: "gui", path: "/apps/fine-tuning" },
  { id: "training", viewType: "tui", path: "/training/tui" },
  { id: "facewear", viewType: "gui", path: "/apps/hearwear" },
  { id: "facewear", viewType: "tui", path: "/apps/hearwear/tui" },
  { id: "smartglasses", viewType: "gui", path: "/apps/smartglasses" },
  { id: "smartglasses", viewType: "tui", path: "/apps/smartglasses/tui" },
  { id: "companion", viewType: "xr", path: "/companion" },
  { id: "contacts", viewType: "xr", path: "/contacts" },
  { id: "hyperliquid", viewType: "xr", path: "/hyperliquid" },
  { id: "lifeops", viewType: "xr", path: "/lifeops" },
  { id: "messages", viewType: "xr", path: "/messages" },
  { id: "model-tester", viewType: "xr", path: "/model-tester" },
  { id: "phone", viewType: "xr", path: "/phone" },
  { id: "polymarket", viewType: "xr", path: "/polymarket" },
  { id: "shopify", viewType: "xr", path: "/shopify" },
  { id: "steward", viewType: "xr", path: "/steward" },
  { id: "vincent", viewType: "xr", path: "/vincent" },
  { id: "wallet", viewType: "xr", path: "/wallet" },
  { id: "2004scape", viewType: "xr", path: "/2004scape" },
  { id: "feed", viewType: "xr", path: "/feed" },
  { id: "views-manager", viewType: "xr", path: "/views" },
  { id: "clawville", viewType: "xr", path: "/clawville" },
  {
    id: "defense-of-the-agents",
    viewType: "xr",
    path: "/defense-of-the-agents",
  },
  { id: "hyperscape", viewType: "xr", path: "/hyperscape" },
  { id: "scape", viewType: "xr", path: "/scape" },
  { id: "screenshare", viewType: "xr", path: "/screenshare" },
  { id: "task-coordinator", viewType: "xr", path: "/task-coordinator" },
  { id: "orchestrator", viewType: "xr", path: "/orchestrator" },
  { id: "trajectory-logger", viewType: "xr", path: "/trajectory-logger" },
  { id: "training", viewType: "xr", path: "/training" },
  { id: "facewear", viewType: "xr", path: "/apps/hearwear/xr" },
  { id: "smartglasses", viewType: "xr", path: "/apps/smartglasses/xr" },
];

const formatPluginViewLabel = (id: string) =>
  id.replaceAll("-", " ").replace(/\b\w/g, (char) => char.toUpperCase());

export const PLUGIN_VIEW_LLM_MOCK_JOURNEYS: ViewJourneyScenario[] =
  PLUGIN_VIEW_LLM_MOCK_CASES.map((view) => {
    const label = formatPluginViewLabel(view.id);
    const surface =
      view.viewType === "tui"
        ? "terminal TUI"
        : view.viewType === "xr"
          ? "spatial XR"
          : "visual GUI";
    return {
      id: `plugin-view-${view.id}-${view.viewType}`,
      description: `Mock LLM route coverage for the ${label} ${surface}`,
      userMessage: `Open the ${surface} for ${label} at ${view.path}`,
      expectedBehavior: `Agent routes to view id "${view.id}" with viewType "${view.viewType}" and path "${view.path}".`,
      verificationCriteria: [
        `response or tool call selects view id "${view.id}"`,
        `response or tool call selects viewType "${view.viewType}"`,
        `response or tool call resolves path "${view.path}"`,
        "response confirms the navigation without exposing bundle internals",
      ],
      tags: ["mock-eval", "navigation", "plugin-view", view.viewType],
    };
  });

export const BASE_VIEW_USER_JOURNEYS: ViewJourneyScenario[] = [
  // ── Discovery ────────────────────────────────────────────────────────────

  {
    id: "show-all-views",
    description: "User asks to see all available views",
    userMessage: "show me all views",
    expectedBehavior:
      "Agent lists the available views with names and brief descriptions, formatted readably",
    verificationCriteria: [
      "response contains at least one view name",
      "response is formatted in a readable list or prose",
      "response does not include internal implementation details like bundle paths",
    ],
    tags: ["discovery"],
  },

  {
    id: "what-views-are-available",
    description: "User asks what views exist using different phrasing",
    userMessage: "what views are available?",
    expectedBehavior: "Agent enumerates available views by name",
    verificationCriteria: [
      "response contains view names",
      "response answers the question without asking for clarification",
    ],
    tags: ["discovery"],
  },

  {
    id: "list-everything",
    description: "User asks for a list of everything they can open",
    userMessage: "what can I open?",
    expectedBehavior: "Agent lists openable views or panels in the UI",
    verificationCriteria: [
      "response mentions at least one named view or panel",
      "response is helpful and not evasive",
    ],
    tags: ["discovery"],
  },

  // ── Navigation: open a specific view ─────────────────────────────────────

  {
    id: "open-wallet",
    description: "User asks to open the wallet view",
    userMessage: "open the wallet",
    expectedBehavior:
      "Agent navigates to or opens the wallet view and confirms the action",
    verificationCriteria: [
      "response mentions wallet",
      "response confirms navigation or opening action",
      "response does not ask the user to navigate manually",
    ],
    tags: ["navigation"],
  },

  {
    id: "go-to-settings",
    description: "User asks to go to settings",
    userMessage: "go to settings",
    expectedBehavior: "Agent navigates to the settings view",
    verificationCriteria: [
      "response confirms navigation to settings",
      "response does not error or express inability",
    ],
    tags: ["navigation"],
  },

  {
    id: "open-chat",
    description: "User asks to open the chat interface",
    userMessage: "open chat",
    expectedBehavior: "Agent opens or focuses the chat view",
    verificationCriteria: [
      "response references chat",
      "response confirms the action",
    ],
    tags: ["navigation"],
  },

  {
    id: "show-trading-dashboard",
    description: "User asks to open the trading dashboard by name",
    userMessage: "show me the trading dashboard",
    expectedBehavior: "Agent opens the trading dashboard view",
    verificationCriteria: [
      "response mentions trading",
      "response confirms navigation or opening",
    ],
    tags: ["navigation"],
  },

  {
    id: "switch-between-views",
    description: "User asks to switch from one view to another",
    userMessage: "switch to the wallet view",
    expectedBehavior:
      "Agent navigates to the wallet view from whatever is currently open",
    verificationCriteria: [
      "response confirms switch or navigation",
      "response mentions wallet",
    ],
    tags: ["navigation"],
  },

  // ── View manager ──────────────────────────────────────────────────────────

  {
    id: "open-view-manager",
    description: "User asks to open the view manager grid",
    userMessage: "open the view manager",
    expectedBehavior:
      "Agent opens the view manager panel showing all available views as a grid",
    verificationCriteria: [
      "response confirms opening the view manager",
      "response does not show an error",
    ],
    tags: ["navigation", "view-manager"],
  },

  {
    id: "show-views-grid",
    description:
      "User asks for a grid or gallery of views using alternate phrasing",
    userMessage: "show me all my panels in a grid",
    expectedBehavior:
      "Agent opens the view manager or lists views in a structured format",
    verificationCriteria: [
      "response lists or displays available views",
      "response is structured and scannable",
    ],
    tags: ["discovery", "view-manager"],
  },

  // ── Search / capability-based discovery ──────────────────────────────────

  {
    id: "search-views-by-capability",
    description: "User searches for views by what they can do (crypto/finance)",
    userMessage: "find views for managing my crypto",
    expectedBehavior:
      "Agent returns views tagged with finance or crypto (wallet, trading, etc.)",
    verificationCriteria: [
      "response mentions wallet or trading or crypto-related view",
      "response does not suggest completely unrelated views like settings",
    ],
    tags: ["discovery", "search"],
  },

  {
    id: "search-views-by-topic",
    description: "User asks for views related to communication",
    userMessage: "what views are there for messaging or chatting?",
    expectedBehavior:
      "Agent surfaces the chat view or other communication-related views",
    verificationCriteria: [
      "response mentions chat or messaging view",
      "response is relevant to communication",
    ],
    tags: ["discovery", "search"],
  },

  {
    id: "find-configuration-views",
    description: "User asks how to configure or set up something",
    userMessage: "where can I configure my account?",
    expectedBehavior:
      "Agent points the user toward settings or configuration views",
    verificationCriteria: [
      "response mentions settings or configuration view",
      "response gives a clear path to configuration",
    ],
    tags: ["discovery", "search"],
  },

  // ── Close / dismiss ───────────────────────────────────────────────────────

  {
    id: "close-current-view",
    description: "User asks to close the current view",
    userMessage: "close the current view",
    expectedBehavior:
      "Agent closes the active view or confirms it has been dismissed",
    verificationCriteria: [
      "response confirms closure or dismissal",
      "response does not open a different view instead",
    ],
    tags: ["navigation"],
  },

  {
    id: "go-back",
    description: "User asks to go back to the previous view",
    userMessage: "go back",
    expectedBehavior: "Agent navigates back or returns to the previous view",
    verificationCriteria: [
      "response acknowledges the back navigation request",
      "response does not open the view manager or a specific unrelated view",
    ],
    tags: ["navigation"],
  },

  // ── Error / edge cases ────────────────────────────────────────────────────

  {
    id: "view-not-found",
    description: "User asks to open a view that does not exist",
    userMessage: "open the inventory view",
    expectedBehavior:
      "Agent tells the user no such view exists and offers alternatives",
    verificationCriteria: [
      "response does not claim success for a nonexistent view",
      "response is helpful: either offers alternatives or explains what views exist",
    ],
    tags: ["error-handling"],
  },

  {
    id: "ambiguous-view-name",
    description: "User uses an ambiguous name that could match multiple views",
    userMessage: "open the dashboard",
    expectedBehavior:
      "Agent either resolves to the most likely view or asks which dashboard the user means",
    verificationCriteria: [
      "response does not silently open the wrong view",
      "response either clarifies or confirms the specific view being opened",
    ],
    tags: ["error-handling"],
  },

  {
    id: "developer-view-not-visible",
    description: "Regular user asks to open a developer-only view",
    userMessage: "open the dev logs",
    expectedBehavior:
      "Agent reports the view is unavailable or requires developer mode, or does not expose it",
    verificationCriteria: [
      "response does not open a developer-only view to a regular user",
      "response handles the request gracefully without a stack trace or raw error",
    ],
    tags: ["error-handling", "permissions"],
  },

  // ── View with capabilities ─────────────────────────────────────────────

  {
    id: "view-with-agent-capability",
    description:
      "User asks the agent to interact with a view that declares capabilities",
    userMessage: "check my wallet balance",
    expectedBehavior:
      "Agent opens or focuses the wallet view and uses the check-balance capability, then reports the result",
    verificationCriteria: [
      "response includes balance information or confirms it is checking",
      "response does not leave the user without an answer",
    ],
    tags: ["capabilities"],
  },

  {
    id: "install-plugin-via-agent",
    description: "User asks agent to install a plugin that adds a new view",
    userMessage: "install the weather plugin",
    expectedBehavior:
      "Agent installs the plugin and confirms the new view is now available",
    verificationCriteria: [
      "response confirms installation or explains any failure",
      "response mentions the new view that the plugin provides",
    ],
    tags: ["plugin-install"],
  },

  // ── Desktop / pinning ─────────────────────────────────────────────────────

  {
    id: "pin-view-as-tab",
    description: "User asks to pin a view as a desktop tab",
    userMessage: "pin the wallet view as a tab",
    expectedBehavior: "Agent pins the wallet view as a persistent desktop tab",
    verificationCriteria: [
      "response confirms the tab has been pinned",
      "response mentions wallet",
    ],
    tags: ["navigation", "desktop"],
  },

  // ── Voice command scenarios ───────────────────────────────────────────────

  {
    id: "voice-open-wallet",
    description: "User speaks a short voice command to open the wallet",
    userMessage: "open wallet",
    expectedBehavior:
      "Agent recognizes the short voice transcription as a navigation intent and opens the wallet view",
    verificationCriteria: [
      "response confirms the wallet view is being opened",
      "response does not ask the user to rephrase or type a longer command",
      "response handles the terse phrasing gracefully without treating it as ambiguous",
      "response does not open an unrelated view",
    ],
    tags: ["voice", "navigation"],
  },

  {
    id: "voice-show-settings",
    description:
      "User speaks a single-word voice command to navigate to settings",
    userMessage: "settings",
    expectedBehavior:
      "Agent interprets the single-word utterance as a navigation request and opens the settings view",
    verificationCriteria: [
      "response confirms navigation to settings",
      "response does not request more context before acting",
      "response does not treat the single word as an error or unknown command",
      "response does not open a different view",
    ],
    tags: ["voice", "navigation"],
  },

  {
    id: "voice-search-views",
    description:
      "User speaks a natural-language voice query to find a trading view",
    userMessage: "find me something for trading",
    expectedBehavior:
      "Agent surfaces the trading dashboard or a relevant finance view matching the spoken intent",
    verificationCriteria: [
      "response mentions a trading or finance-related view",
      "response does not return completely unrelated views",
      "response is actionable: it either opens the view or presents a navigable option",
      "response acknowledges the search intent rather than asking for exact view names",
    ],
    tags: ["voice", "search", "discovery"],
  },

  {
    id: "voice-ambiguous-navigation",
    description:
      "User says 'go home', which could map to chat or the main view",
    userMessage: "go home",
    expectedBehavior:
      "Agent navigates to the primary home or chat view, or disambiguates between home and chat with a brief clarification",
    verificationCriteria: [
      "response navigates to a plausible home-equivalent view (chat, main, or similar)",
      "if ambiguous, response asks a single focused clarifying question rather than listing all views",
      "response does not open an unrelated view such as settings or wallet",
      "response does not return an error or claim no view matches",
    ],
    tags: ["voice", "navigation", "error-handling"],
  },

  {
    id: "voice-view-manager",
    description:
      "User says 'show apps', a legacy voice phrase that should open the view manager",
    userMessage: "show apps",
    expectedBehavior:
      "Agent maps the legacy 'show apps' phrasing to the view manager and opens it",
    verificationCriteria: [
      "response opens or confirms opening the view manager",
      "response does not reject the phrasing as unrecognized",
      "response does not open a single specific app view instead of the manager",
      "response handles the legacy phrasing transparently without requiring rephrasing",
    ],
    tags: ["voice", "navigation", "view-manager"],
  },

  // ── View interaction scenarios ────────────────────────────────────────────

  {
    id: "agent-clicks-in-view",
    description: "User asks the agent to click a button inside the wallet view",
    userMessage: "click the send button in the wallet view",
    expectedBehavior:
      "Agent uses the wallet view's declared capability to trigger the send action, or navigates to the send flow and confirms",
    verificationCriteria: [
      "response confirms the send button was activated or the send flow was initiated",
      "response references the wallet view context",
      "response does not claim inability to interact with views",
      "response does not simply describe the button without acting",
    ],
    tags: ["interaction", "capabilities"],
  },

  {
    id: "agent-reads-view-state",
    description:
      "User asks the agent to read live state from the open wallet view",
    userMessage: "what's my balance in the wallet view?",
    expectedBehavior:
      "Agent reads the current balance from the wallet view's state and reports it to the user",
    verificationCriteria: [
      "response includes a balance value or confirms it is fetching the balance",
      "response does not return a static or hardcoded placeholder value",
      "response references the wallet view as the source of the information",
      "response does not ask the user to open the wallet first if it is already open",
    ],
    tags: ["interaction", "capabilities"],
  },

  {
    id: "agent-refreshes-view",
    description: "User asks the agent to refresh the wallet view",
    userMessage: "refresh the wallet",
    expectedBehavior:
      "Agent triggers a refresh of the wallet view and confirms the action",
    verificationCriteria: [
      "response confirms the wallet view has been refreshed or is refreshing",
      "response does not close and reopen the view as a substitute for refresh",
      "response does not navigate away from the wallet",
      "response is concise and does not require follow-up from the user",
    ],
    tags: ["interaction", "navigation"],
  },

  {
    id: "agent-fills-form-in-view",
    description:
      "User asks the agent to fill in a recipient address in the wallet send form",
    userMessage:
      "fill in the recipient address with 0xAbCd1234 in the wallet send form",
    expectedBehavior:
      "Agent locates the recipient address field in the wallet send form and populates it with the provided address",
    verificationCriteria: [
      "response confirms the recipient address field has been filled",
      "response includes or echoes the address to confirm correctness",
      "response does not submit the form without explicit user confirmation",
      "response does not navigate away from the send form",
      "response handles the address value faithfully without truncating or modifying it",
    ],
    tags: ["interaction", "capabilities"],
  },

  // ── Multi-turn / context scenarios ───────────────────────────────────────

  {
    id: "open-then-interact",
    description:
      "User first opens wallet, then in a follow-up asks to send funds",
    userMessage: "send some funds",
    expectedBehavior:
      "Agent retains context that the wallet is open and initiates the send flow without requiring the user to restate the view",
    verificationCriteria: [
      "response initiates the send flow or asks for send details (amount, recipient)",
      "response does not ask the user to open the wallet again",
      "response demonstrates awareness that the wallet view is the current context",
      "response does not open a different view before responding",
    ],
    tags: ["multi-turn", "interaction"],
  },

  {
    id: "switch-views-mid-task",
    description:
      "User switches from wallet to settings mid-task and then returns",
    userMessage: "actually, take me back to the wallet",
    expectedBehavior:
      "Agent navigates back to the wallet view, restoring the previous context",
    verificationCriteria: [
      "response confirms navigation back to the wallet view",
      "response does not lose prior wallet context (e.g., in-progress send form state)",
      "response does not open an unrelated view",
      "response handles the implicit 'back' intent without requiring exact view name",
    ],
    tags: ["multi-turn", "navigation"],
  },

  // ── E2E journey scenarios ─────────────────────────────────────────────────

  {
    id: "complete-voice-journey",
    description:
      "Full end-to-end flow: user speaks, agent opens view, reads state, and confirms with user",
    userMessage: "open my wallet and tell me my balance",
    expectedBehavior:
      "Agent opens the wallet view, reads the current balance from its state, and reports it back with a confirmation",
    verificationCriteria: [
      "response confirms the wallet view was opened",
      "response includes or requests the balance value from the view",
      "response delivers the balance to the user in the same turn or the immediately following turn",
      "response does not require the user to manually navigate or read the UI themselves",
      "response is coherent across the open and read steps without contradicting itself",
    ],
    tags: ["e2e", "voice", "interaction"],
  },

  {
    id: "first-run-to-view",
    description:
      "New user sees the chat interface, asks what the agent can do, and agent opens the view manager",
    userMessage: "what can you do?",
    expectedBehavior:
      "Agent explains its capabilities at a high level and proactively opens the view manager to show available views",
    verificationCriteria: [
      "response describes at least two agent capabilities (e.g., navigation, reading state, search)",
      "response opens or offers to open the view manager to show available views",
      "response is welcoming and oriented toward a new user",
      "response does not overwhelm with technical jargon or internal system details",
      "response invites the user to pick a view or ask a follow-up question",
    ],
    tags: ["e2e", "discovery", "view-manager"],
  },
];

const VIEW_JOURNEY_EDGE_VARIANTS: Array<{
  suffix: string;
  description: string;
  mutateMessage: (message: string) => string;
  criteria: string[];
  tags: string[];
}> = [
  {
    suffix: "voice-terse",
    description: "terse voice-command phrasing",
    mutateMessage: (message) =>
      message
        .replace(/^show me /i, "show ")
        .replace(/^what views are available\??$/i, "views?")
        .replace(/^open the /i, "open ")
        .replace(/^go to /i, "")
        .replace(/[?.!]$/g, ""),
    criteria: [
      "response handles terse or voice-like phrasing without asking for a full sentence",
      "response preserves the original intent",
    ],
    tags: ["voice"],
  },
  {
    suffix: "polite",
    description: "polite natural-language request",
    mutateMessage: (message) =>
      `could you please ${message.replace(/[?.!]$/g, "")}?`,
    criteria: [
      "response does not mistake politeness for uncertainty",
      "response acts on the embedded request",
    ],
    tags: [],
  },
  {
    suffix: "urgent",
    description: "urgent user request",
    mutateMessage: (message) => `quick, ${message.replace(/[?.!]$/g, "")}`,
    criteria: [
      "response remains concise under urgency",
      "response does not skip required confirmation or safety handling",
    ],
    tags: [],
  },
  {
    suffix: "followup",
    description: "follow-up after prior context",
    mutateMessage: (message) =>
      `following up from the last thing we were doing, ${message.replace(/[?.!]$/g, "")}`,
    criteria: [
      "response uses the latest request rather than stale prior context",
      "response remains coherent as a follow-up",
    ],
    tags: ["multi-turn"],
  },
  {
    suffix: "mobile-typo",
    description: "mobile-style casual punctuation",
    mutateMessage: (message) =>
      `${message.toLowerCase().replace(/[?.!]$/g, "")} pls`,
    criteria: [
      "response tolerates casual mobile phrasing",
      "response does not require the user to retype the request",
    ],
    tags: [],
  },
  {
    suffix: "quoted",
    description: "request embedded in quoted text",
    mutateMessage: (message) => `do this exact request: "${message}"`,
    criteria: [
      "response follows the quoted request",
      "response does not include quotation-wrapper implementation details",
    ],
    tags: [],
  },
  {
    suffix: "negative-space",
    description: "request with explicit non-goal",
    mutateMessage: (message) =>
      `${message.replace(/[?.!]$/g, "")}; don't show me raw debug info`,
    criteria: [
      "response does not expose raw debug info",
      "response still fulfills the main view request",
    ],
    tags: [],
  },
  {
    suffix: "legacy-app-wording",
    description: "legacy apps/panels wording",
    mutateMessage: (message) =>
      message
        .replace(/\bviews\b/gi, "apps")
        .replace(/\bview\b/gi, "app")
        .replace(/\bpanels\b/gi, "apps")
        .replace(/\bpanel\b/gi, "app"),
    criteria: [
      "response maps legacy app/panel wording onto the view system",
      "response does not reject the request as using the wrong term",
    ],
    tags: ["view-manager"],
  },
  {
    suffix: "accessibility",
    description: "accessibility-oriented phrasing",
    mutateMessage: (message) =>
      `I'm using voice control, ${message.replace(/[?.!]$/g, "")}`,
    criteria: [
      "response accommodates voice-control context",
      "response avoids instructions that require manual navigation when action is possible",
    ],
    tags: ["voice"],
  },
  {
    suffix: "compound-context",
    description: "compound sentence with extra context",
    mutateMessage: (message) =>
      `I'm in the middle of something and need the UI to keep up: ${message}`,
    criteria: [
      "response extracts the actionable view intent from surrounding context",
      "response does not over-focus on the filler context",
    ],
    tags: ["e2e"],
  },
];

function expandViewJourneyScenarios(
  base: readonly ViewJourneyScenario[],
): ViewJourneyScenario[] {
  return base.flatMap((scenario) =>
    VIEW_JOURNEY_EDGE_VARIANTS.map((variant) => ({
      ...scenario,
      id: `${scenario.id}--${variant.suffix}`,
      description: `${scenario.description} (${variant.description})`,
      userMessage: variant.mutateMessage(scenario.userMessage),
      expectedBehavior: scenario.expectedBehavior,
      verificationCriteria: [
        ...scenario.verificationCriteria,
        ...variant.criteria,
      ],
      tags: Array.from(new Set([...scenario.tags, ...variant.tags])),
    })),
  );
}

export const EXPANDED_VIEW_USER_JOURNEYS: ViewJourneyScenario[] =
  expandViewJourneyScenarios(BASE_VIEW_USER_JOURNEYS);

if (
  EXPANDED_VIEW_USER_JOURNEYS.length !==
  BASE_VIEW_USER_JOURNEYS.length * 10
) {
  throw new Error(
    `view journey expansion must add exactly 10x (${BASE_VIEW_USER_JOURNEYS.length * 10}); got ${EXPANDED_VIEW_USER_JOURNEYS.length}`,
  );
}

export const VIEW_USER_JOURNEYS: ViewJourneyScenario[] = [
  ...BASE_VIEW_USER_JOURNEYS,
  ...EXPANDED_VIEW_USER_JOURNEYS,
];

export function countViewJourneyScenarios(): {
  existing: number;
  added: number;
  total: number;
  multiplierAdded: number;
} {
  return {
    existing: BASE_VIEW_USER_JOURNEYS.length,
    added: EXPANDED_VIEW_USER_JOURNEYS.length,
    total: VIEW_USER_JOURNEYS.length,
    multiplierAdded:
      EXPANDED_VIEW_USER_JOURNEYS.length / BASE_VIEW_USER_JOURNEYS.length,
  };
}

/**
 * Returns all scenarios matching any of the given tags.
 */
export function getScenariosByTag(...tags: string[]): ViewJourneyScenario[] {
  return VIEW_USER_JOURNEYS.filter((s) => s.tags.some((t) => tags.includes(t)));
}

/**
 * Returns the scenario with the given id, or throws if not found.
 */
export function getScenarioById(id: string): ViewJourneyScenario {
  const scenario = VIEW_USER_JOURNEYS.find((s) => s.id === id);
  if (!scenario) {
    throw new Error(`No view journey scenario with id "${id}"`);
  }
  return scenario;
}
