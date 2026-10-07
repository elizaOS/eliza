/** Design A trigger: which messages make SET_STATE a must-call for the planner. */

import { expect, test } from "bun:test";
import { isNetworkStateIntent } from "./state-intent";

test("detects common availability changes", () => {
  for (const text of [
    "pause my network intros until oct 20",
    "taking a break from the network until december",
    "super busy this week, hold off on new intros",
    "I'm traveling to New York until November 3",
    "I'm back, open to intros again",
    "unpause me",
    "mark me busy",
    "can you snooze the network for a week",
    "flying to Berlin till the 3rd",
    "I'm away next week",
    "back in SF, open to meeting people again",
  ]) {
    expect(isNetworkStateIntent(text), text).toBe(true);
  }
});

test("ignores near-misses, third parties and quoted text", () => {
  for (const text of [
    "thanks, that last intro was great",
    "my gym membership is paused lol",
    "I'm back from the gym, so tired",
    "who should I meet this week?",
    'my friend said "pause all your intros" but keep them coming',
    "Sam is traveling to Tokyo until the 30th, tell him to ping me",
    "my cofounder is slammed this week",
    "is the bar busy until late?",
    "I'm free tomorrow at 3 for the intro with Jo",
    "hey",
  ]) {
    expect(isNetworkStateIntent(text), text).toBe(false);
  }
});
