import { describe, expect, it } from "vitest";
import {
  isClaudeSdkApiErrorMessage,
  isClaudeSubscriptionLimitMessage,
} from "../src/claude-sdk-session.ts";

// Live regression (2026-07-01): when the Agent SDK monthly credit ran dry the SDK
// ended the turn cleanly but streamed the subscription-limit UI string as the
// assistant "answer", and the bot relayed it to Discord users verbatim
// ("You've hit your session limit · resets 9:30pm (UTC)") 7 times.
describe("isClaudeSubscriptionLimitMessage", () => {
  it("matches the real leaked subscription-limit strings", () => {
    expect(
      isClaudeSubscriptionLimitMessage("You've hit your session limit · resets 9:30pm (UTC)")
    ).toBe(true);
    expect(
      isClaudeSubscriptionLimitMessage("You've hit your session limit · resets 11:30am (UTC)")
    ).toBe(true);
    expect(
      isClaudeSubscriptionLimitMessage("You've reached your usage limit for this month.")
    ).toBe(true);
  });

  it("matches known envelope variants (CLI epoch form, non-UTC interpunct)", () => {
    // The classic Claude CLI limit string: "Claude AI usage limit reached|<epoch>".
    expect(isClaudeSubscriptionLimitMessage("Claude AI usage limit reached|1735689600")).toBe(true);
    // Interpunct separator variants without a "(UTC)" suffix.
    expect(isClaudeSubscriptionLimitMessage("5-hour limit reached ∙ resets 3am")).toBe(true);
  });

  it("does not match genuine model answers, even ones discussing limits", () => {
    for (const answer of [
      "Bitcoin is at $58,546 USD right now (via CoinGecko).",
      "Paris.",
      "3 minutes. The machines run in parallel so the time never changes.",
      // a real, long answer that happens to explain rate limits must NOT trip it
      "The API rate limit is 60 requests per minute and it resets hourly; " +
        "handle it with exponential backoff so you never exceed the quota in production.",
      // adversarial-review probes: SHORT genuine answers about the user's limits.
      "No, you haven't hit your rate limit yet.",
      "Your API limit resets at midnight (UTC).",
      "It means you hit your session limit for the subscription.",
      "Yes — you hit the daily limit on that key; try tomorrow.",
      // mid-sentence second-person phrase (envelope form is start-anchored)
      "Yes — you've hit your daily limit on that key.",
    ]) {
      expect(isClaudeSubscriptionLimitMessage(answer)).toBe(false);
    }
  });
});

// Second leak class (2026-07-02): the SDK streams upstream API failures as
// assistant text — "API Error: 400 messages: text content blocks must be
// non-empty" was relayed verbatim to Discord users 18x when empty relay lines
// produced an empty content block.
describe("isClaudeSdkApiErrorMessage", () => {
  it("matches the SDK's API-error envelope", () => {
    for (const s of [
      "API Error: 400 messages: text content blocks must be non-empty",
      "API Error: 429 rate limited",
      "API Error: 529 overloaded",
      "  API Error: 500 internal server error",
      // Non-numeric envelopes baked into the shipping CLI binary:
      "API Error: Request was aborted.",
      "API Error: Missing Tool Result Block",
      "API Error",
    ]) {
      expect(isClaudeSdkApiErrorMessage(s)).toBe(true);
    }
  });

  it("does not match genuine answers that mention API errors", () => {
    for (const s of [
      "An API Error: 400 usually means your request body is malformed.",
      "You're seeing 'API Error: 400' because the content block was empty.",
      "The API returned an error: 400.",
      "Error handling matters — retry on API Error status codes like 429.",
      "API Error handling is a best practice for resilient clients.",
      "API Errors come in many flavors; retry the retryable ones.",
      "42",
    ]) {
      expect(isClaudeSdkApiErrorMessage(s)).toBe(false);
    }
  });
});
