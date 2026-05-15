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

export const VIEW_USER_JOURNEYS: ViewJourneyScenario[] = [
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
    expectedBehavior: "Agent navigates to the wallet view from whatever is currently open",
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
    description: "User asks for a grid or gallery of views using alternate phrasing",
    userMessage: "show me all my panels in a grid",
    expectedBehavior: "Agent opens the view manager or lists views in a structured format",
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
    expectedBehavior: "Agent surfaces the chat view or other communication-related views",
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
    expectedBehavior: "Agent points the user toward settings or configuration views",
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
    expectedBehavior: "Agent closes the active view or confirms it has been dismissed",
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
    description: "User asks the agent to interact with a view that declares capabilities",
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
    description: "User speaks a single-word voice command to navigate to settings",
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
    description: "User speaks a natural-language voice query to find a trading view",
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
    description: "User says 'go home', which could map to chat or the main view",
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
    description: "User says 'show apps', a legacy voice phrase that should open the view manager",
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
    description: "User asks the agent to read live state from the open wallet view",
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
    description: "User asks the agent to fill in a recipient address in the wallet send form",
    userMessage: "fill in the recipient address with 0xAbCd1234 in the wallet send form",
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
    description: "User first opens wallet, then in a follow-up asks to send funds",
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
    description: "User switches from wallet to settings mid-task and then returns",
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
    id: "onboarding-to-view",
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

/**
 * Returns all scenarios matching any of the given tags.
 */
export function getScenariosByTag(
  ...tags: string[]
): ViewJourneyScenario[] {
  return VIEW_USER_JOURNEYS.filter((s) =>
    s.tags.some((t) => tags.includes(t)),
  );
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
