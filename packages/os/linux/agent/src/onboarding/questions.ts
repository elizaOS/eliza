// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 NubsCarson and contributors

/**
 * Conversational onboarding script — the "Her" film's opening cadence,
 * adapted for a usbeliza first-boot session.
 *
 * Locked decision: setup is a chat. No wizards, no popups, no separate
 * UI. Eliza herself conducts the conversation from the very first turn,
 * running on the bundled Eliza-1 0.8B baseline — no network, no cloud,
 * no Claude/Codex needed to get started. Everything that *would* be a
 * settings panel in another OS is instead a topic Eliza can talk about
 * and act on through the existing intent system (`network`, persistence,
 * model picker, etc.).
 *
 * The script below is intentionally short and warm. Each question takes
 * one chat turn; the answers populate `~/.eliza/calibration.toml`. After
 * the last question Eliza offers (but does not force) the optional
 * follow-ups: connect Wi-Fi, set up encrypted persistence, link cloud
 * accounts. The user can also skip any prompt with "skip" or change
 * focus mid-flow with intents like "build me a calendar" — the
 * onboarding state pauses and resumes.
 */

import type { CalibrationBlock } from "../persona.ts";

/** One step in the conversational onboarding ladder. */
export interface OnboardingQuestion {
  /** Stable identifier — also the key in the persisted partial calibration. */
  readonly id: keyof CalibrationBlock;
  /** What Eliza says to elicit the answer. */
  readonly prompt: string;
  /** Optional follow-up sentence when the user gives a one-word answer. */
  readonly follow?: string;
  /**
   * Parse the user's reply into the calibration value. Returns
   * `undefined` if the answer is ambiguous — the dispatcher will
   * re-ask with a clarifying hint.
   */
  readonly parse: (
    reply: string,
  ) => CalibrationBlock[OnboardingQuestion["id"]] | undefined;
  /**
   * Optional clarifying re-ask shown when `parse` returns undefined.
   * Helps the user understand what kind of answer fits. Defaults to
   * just repeating the prompt verbatim.
   */
  readonly clarify?: string;
}

/**
 * Yes/no parser for the Claude offer question. Liberal:
 * accepts "yes" / "yeah" / "sure" / "ok" / "do it" / "connect" / "wifi"
 * for accept; "no" / "nope" / "skip" / "later" / "stay offline" / "stay
 * local" for decline. Returns undefined for ambiguous so the dispatcher
 * re-asks with the question's clarify text.
 */
function parseOffer(reply: string): boolean | undefined {
  const norm = reply.trim().toLowerCase();
  if (norm === "") return undefined;
  if (
    /^(y|yes|yeah|yep|yup|sure|ok|okay|please|let'?s|go|do it|connect|wifi|sign in|log in|login)/.test(
      norm,
    )
  ) {
    return true;
  }
  if (
    /^(n|no|nope|nah|not now|later|skip|stay (offline|local)|local|offline|maybe later)/.test(
      norm,
    )
  ) {
    return false;
  }
  return undefined;
}

/**
 * The three onboarding questions, in order:
 *
 *   1. name                       — what Eliza calls the user
 *   2. claudeOfferAccepted        — offer to sign into Claude (triggers
 *                                   the multi-turn claude-flow on yes;
 *                                   user pastes the auth code in chat)
 *   3. buildIntent                — freeform "what do you want me to
 *                                   build first?" — answer auto-routes
 *                                   to the BUILD_APP action so the
 *                                   first app appears immediately after
 *                                   onboarding completes
 *
 * Trimmed from the v35 ten-question flow by user request 2026-05-13:
 * the language / timezone / chronotype / etc questions were a slog for
 * the first 30 seconds of using the OS. Locale gets a sensible default
 * (en_US.UTF-8 / UTC); the user can ask Eliza to change either later.
 *
 * Wi-Fi was also dropped from onboarding — accessible from chat any
 * time via "connect to wifi" (multi-turn picker flow). Most users boot
 * on ethernet anyway and the wifi prompt during onboarding just slowed
 * everyone else down.
 *
 * Adding/removing a question is a breaking change for the persisted
 * `~/.eliza/calibration.toml` — older multi-field calibration files
 * still parse because every non-name field is optional.
 */
export const QUESTIONS: readonly OnboardingQuestion[] = [
  {
    id: "name",
    prompt: "Hi. I'm Eliza. What should I call you?",
    parse: (reply: string) => {
      // Anything reasonable — trim, cap length, reject empty.
      const text = reply.trim().replace(/^[\W_]+|[\W_]+$/g, "");
      if (text.length === 0 || text.length > 64) return undefined;
      return text;
    },
    clarify: "Just a name or a handle — whatever you'd like me to use.",
  },
  {
    id: "claudeOfferAccepted",
    prompt:
      "Want to sign into Claude? It's the difference between me writing " +
      "apps you'll actually use and me writing apps that mostly work. " +
      "I'll open a browser; you log in there, then paste the code back here. " +
      "Or skip and stay on the local model — that's fine too.",
    parse: parseOffer,
    clarify: "Yes to sign in, no to stay local-only. Up to you.",
  },
  {
    id: "buildIntent",
    prompt:
      "Last question. What do you want me to build first? Could be a clock, " +
      "a notes app, a calculator, a calendar — whatever feels useful. " +
      'Or say "nothing yet" and we can just chat.',
    parse: (reply: string) => {
      const text = reply.trim();
      if (text.length === 0 || text.length > 256) return undefined;
      return text;
    },
    clarify:
      'Just describe one thing in a sentence — e.g. "a sticky-notes app" ' +
      'or "a timer". Say "nothing yet" to skip.',
  },
] as const;
/**
 * Build the warm completion message after the last calibration question.
 * Reads the user's calibration answers and tailors the response — name +
 * a contextual first-thing-to-do drawn from `workFocus`. No bullet lists,
 * no menu of commands. Eliza just continues the conversation.
 *
 * Mirrors the Her film's hand-off: after Sam's setup, she says
 * something specific to Theodore — references his answers, suggests one
 * gentle next step. Multi-step setup happens later, conversationally.
 */
export function completionMessage(answers: Partial<CalibrationBlock>): string {
  const name = typeof answers.name === "string" ? answers.name : "there";
  const intent =
    typeof answers.buildIntent === "string" ? answers.buildIntent.trim() : "";
  const intentLower = intent.toLowerCase();
  const skipped =
    intentLower === "" ||
    /^(nothing|skip|later|nah|no|none|nope|not now|not yet|nope nothing|nothing yet)\b/.test(
      intentLower,
    );

  if (skipped) {
    // No build requested. Open-ended invitation — chat is the desktop.
    return `OK, ${name}. Ready when you are. Say "build me X" anytime — a clock, a notes app, anything you can think of — and I'll make it.`;
  }

  // Build IS in flight (the dispatcher fired BUILD_APP async). Frame the
  // wait time honestly so the user doesn't wonder if it's stuck:
  // claude-codegen runs ~20-60s with claude signed in, ~2-5 min on the
  // local 1B if not.
  //
  // Don't try to grammar-fix the user's phrasing — they already said
  // "a clock" or "calendar" or "build me a notes app"; we strip the
  // leading "build me" / "make me" if they used it but otherwise
  // leave the words alone. The slug for "open <thing>" is the last
  // meaningful word so they don't have to remember articles.
  const cleanedIntent =
    intent.replace(/^(build me|make me|build|make)\s+/i, "").trim() || intent;
  const lastWord =
    cleanedIntent
      .split(/\s+/)
      .filter((w) => w.length > 0 && !/^(a|an|the|some|me|my)$/i.test(w))
      .pop() ?? cleanedIntent;
  return (
    `OK, ${name}. I'm building ${cleanedIntent} now — should take ` +
    `about 30 seconds. When it's ready, say "open ${lastWord}" ` +
    `and I'll pop it open. Anything else you want to chat about while I work?`
  );
}

/**
 * @deprecated Use `completionMessage(answers)` instead. Kept as a
 * fallback so the dispatcher's defensive path (calibration written but
 * answers map empty) still emits a sane string.
 */
export const ONBOARDING_COMPLETE_MESSAGE = completionMessage({});

/**
 * The pre-onboarding greeting shown when the user types anything at all
 * before answering the first question. Mirrors the Her opening beat.
 * The local model never sees this — we render it deterministically so
 * first-boot latency is single-digit milliseconds.
 */
export const ONBOARDING_GREETING = QUESTIONS[0]?.prompt ?? "Hi.";
