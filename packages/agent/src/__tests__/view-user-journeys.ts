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
];

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
