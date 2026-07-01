import { describe, expect, it } from "vitest";
import { isClaudeSubscriptionLimitMessage } from "../src/claude-sdk-session.ts";

// Live regression (2026-07-01): when the Agent SDK monthly credit ran dry the SDK
// ended the turn cleanly but streamed the subscription-limit UI string as the
// assistant "answer", and the bot relayed it to Discord users verbatim
// ("You've hit your session limit · resets 9:30pm (UTC)") 7 times.
describe("isClaudeSubscriptionLimitMessage", () => {
  it("matches the real leaked subscription-limit strings", () => {
    expect(
      isClaudeSubscriptionLimitMessage(
        "You've hit your session limit · resets 9:30pm (UTC)",
      ),
    ).toBe(true);
    expect(
      isClaudeSubscriptionLimitMessage(
        "You've hit your session limit · resets 11:30am (UTC)",
      ),
    ).toBe(true);
    expect(
      isClaudeSubscriptionLimitMessage(
        "You've reached your usage limit for this month.",
      ),
    ).toBe(true);
  });

  it("does not match genuine model answers, even ones discussing limits", () => {
    for (const answer of [
      "Bitcoin is at $58,546 USD right now (via CoinGecko).",
      "Paris.",
      "3 minutes. The machines run in parallel so the time never changes.",
      // a real, long answer that happens to explain rate limits must NOT trip it
      "The API rate limit is 60 requests per minute and it resets hourly; " +
        "handle it with exponential backoff so you never exceed the quota in production.",
    ]) {
      expect(isClaudeSubscriptionLimitMessage(answer)).toBe(false);
    }
  });
});
