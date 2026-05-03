/**
 * @module intent
 * @description Two-tier intent detection for form interactions
 *
 * ## Design Rationale
 *
 * Intent detection determines what the user wants to do:
 * - Fill form fields? Submit? Cancel? Undo?
 *
 * We use a two-tier approach:
 *
 * ### Tier 1: Fast Path (English Keywords)
 *
 * Simple regex matching for common English phrases. This is:
 * - **Fast**: No LLM call, instant response
 * - **Reliable**: Simple patterns rarely fail
 * - **Limited**: Only works for English, explicit commands
 *
 * Used for: "submit", "undo", "cancel", "skip", etc.
 *
 * ### Tier 2: LLM Fallback
 *
 * When fast path returns null, we use LLM for:
 * - **Non-English**: "enviar" (Spanish for "submit")
 * - **Ambiguous**: "I think I'm done?" (submit or just commenting?)
 * - **Complex**: Multi-part messages with intent + data
 *
 * The LLM call also extracts field values, so we bundle
 * intent detection with extraction to save latency.
 *
 * ## Why Fast Path First
 *
 * 1. **Latency**: LLM calls take 500ms-2s. Fast path is <1ms.
 * 2. **Cost**: Each LLM call has token cost. Fast path is free.
 * 3. **Reliability**: Regex patterns are deterministic. LLM can be unpredictable.
 *
 * ## Intent Categories
 *
 * **Lifecycle Intents** - Change session state:
 * - submit, stash, restore, cancel
 *
 * **UX Intents** - Helper actions:
 * - undo, skip, explain, example, progress, autofill
 *
 * **Data Intents** - Provide information:
 * - fill_form (with extractions)
 *
 * **Fallback**:
 * - other (unknown intent, may still have data)
 */

import type { FormIntent } from "./types";

/**
 * Quick intent detection using English keywords.
 *
 * Fast path for common English phrases - avoids LLM call for obvious intents.
 * Returns null if no match found, triggering LLM fallback.
 *
 * WHY regex-based:
 * - Deterministic - same input always gives same output
 * - Fast - no API calls, no parsing
 * - Easy to add patterns
 *
 * WHY word boundaries (\b):
 * - Prevents false matches ("undoing" matching "undo")
 * - Allows matching in context ("I want to cancel")
 *
 * @param text - User message text
 * @returns Detected intent or null if no fast-path match
 */
export function quickIntentDetect(text: string): FormIntent | null {
  const lower = text.toLowerCase().trim();

  // Empty or too short - probably not a command
  // WHY: Single letters or empty strings aren't meaningful commands
  if (lower.length < 2) {
    return null;
  }

  // ═══ LIFECYCLE INTENTS ═══
  // These change the session state

  // Restore - resume a saved form
  // WHY these phrases: Natural ways to continue interrupted work
  if (
    /\b(resume|continue|pick up where|go back to|get back to)\b/.test(lower)
  ) {
    return "restore";
  }

  // Submit - complete and submit the form
  // WHY "all set" included: Common natural confirmation phrase
  if (
    /\b(submit|done|finish|send it|that'?s all|i'?m done|complete|all set)\b/.test(
      lower,
    )
  ) {
    return "submit";
  }

  // Stash - save for later without submitting
  // WHY exclude "save and submit": User wants to submit, not stash
  if (
    /\b(save|stash|later|hold on|pause|save for later|come back|save this)\b/.test(
      lower,
    )
  ) {
    // But not "save" in context of submitting
    if (!/\b(save and submit|save and send)\b/.test(lower)) {
      return "stash";
    }
  }

  // Cancel - abandon the form
  // WHY "quit" and "exit": Common ways to abandon a process
  if (
    /\b(cancel|abort|nevermind|never mind|forget it|stop|quit|exit)\b/.test(
      lower,
    )
  ) {
    return "cancel";
  }

  // ═══ UX MAGIC INTENTS ═══
  // Helper actions that don't directly provide data

  // Undo - revert the last change
  // WHY "oops" and "that's wrong": Natural error expressions
  if (
    /\b(undo|go back|wait no|change that|oops|that'?s wrong|wrong|not right)\b/.test(
      lower,
    )
  ) {
    return "undo";
  }

  // Skip - skip the current optional field
  // WHY exclude "skip to": That's navigation, not skipping current field
  if (
    /\b(skip|pass|don'?t know|next one|next|don'?t have|no idea)\b/.test(lower)
  ) {
    // But not "skip to" (navigation)
    if (!/\bskip to\b/.test(lower)) {
      return "skip";
    }
  }

  // Explain - "why do you need this?"
  // WHY end anchor: "why" at end of sentence is usually a question
  if (
    /\b(why|what'?s that for|explain|what do you mean|what is|purpose|reason)\b\??$/i.test(
      lower,
    )
  ) {
    return "explain";
  }
  // Also match standalone "why?"
  if (/^why\??$/i.test(lower)) {
    return "explain";
  }

  // Example - "give me an example"
  // WHY end anchor: "like what?" is asking for example
  if (
    /\b(example|like what|show me|such as|for instance|sample)\b\??$/i.test(
      lower,
    )
  ) {
    return "example";
  }
  // Also match standalone "example?" or "e.g.?"
  if (/^(example|e\.?g\.?)\??$/i.test(lower)) {
    return "example";
  }

  // Progress - "how far am I?"
  // WHY these phrases: Natural ways to ask about completion status
  if (
    /\b(how far|how many left|progress|status|how much more|where are we)\b/.test(
      lower,
    )
  ) {
    return "progress";
  }

  // Autofill - "use my usual values"
  // WHY: Users with repeat forms want saved values
  if (
    /\b(same as|last time|use my usual|like before|previous|from before)\b/.test(
      lower,
    )
  ) {
    return "autofill";
  }

  // No match - let LLM handle it
  // WHY null return: Signals caller to use LLM fallback
  return null;
}

// ============================================================================
// INTENT HELPERS
// ============================================================================

/**
 * Check if intent is a lifecycle intent (affects session state).
 *
 * Lifecycle intents:
 * - submit: Completes the form
 * - stash: Saves for later
 * - restore: Resumes a saved form
 * - cancel: Abandons the form
 *
 * WHY this helper:
 * - Lifecycle intents need special handling
 * - Often preempt normal message processing
 * - May need confirmation (e.g., cancel)
 */
export function isLifecycleIntent(intent: FormIntent): boolean {
  return ["submit", "stash", "restore", "cancel"].includes(intent);
}

/**
 * Check if intent is a UX intent (doesn't directly provide data).
 *
 * UX intents:
 * - undo: Revert last change
 * - skip: Skip optional field
 * - explain: "Why do you need this?"
 * - example: "Give me an example"
 * - progress: "How far am I?"
 * - autofill: "Use my saved values"
 *
 * WHY this helper:
 * - UX intents are helper actions
 * - Don't extract data, just modify session or provide info
 * - Agent response is informational
 */
export function isUXIntent(intent: FormIntent): boolean {
  return [
    "undo",
    "skip",
    "explain",
    "example",
    "progress",
    "autofill",
  ].includes(intent);
}

/**
 * Check if intent likely contains data to extract.
 *
 * Data intents:
 * - fill_form: User is providing field values
 * - other: Unknown intent, may have data
 *
 * WHY this helper:
 * - Determines if we should run extraction
 * - fill_form and other may have inline data
 * - Lifecycle and UX intents don't have data
 */
export function hasDataToExtract(intent: FormIntent): boolean {
  return intent === "fill_form" || intent === "other";
}
