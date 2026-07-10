/**
 * The canonical first-run opener Eliza speaks to a brand-new user. The
 * first-run conductor seeds it as the first chat turn and the continuous-chat
 * overlay reuses the same text for its pre-conductor fallback turn, so the two
 * can never drift apart — byte-identical text is what lets the overlay's
 * latest-first-run-turn dedupe collapse them into a single greeting.
 */
export const FIRST_RUN_GREETING =
  "Hi, I'm Eliza! Seems like you're new here — let's get started.";
