/**
 * Unit coverage for the subscription-cancellation playbook registry lookup:
 * `findLifeOpsSubscriptionPlaybook` resolves a discovered subscription
 * (service name, slug, or alias) to the automation playbook used to cancel
 * it. A wrong match routes the user into another service's cancellation
 * flow — a real behavioral hazard — so matching must be exact on
 * key/serviceName/aliases and conservative on fuzzy substring fallback.
 */
import { describe, expect, it } from "vitest";
import {
  findLifeOpsSubscriptionPlaybook,
  listLifeOpsSubscriptionPlaybooks,
} from "./subscriptions-playbooks";

describe("listLifeOpsSubscriptionPlaybooks", () => {
  it("returns a non-empty registry with unique keys", () => {
    const playbooks = listLifeOpsSubscriptionPlaybooks();
    expect(playbooks.length).toBeGreaterThan(10);
    const keys = new Set(playbooks.map((p) => p.key));
    expect(keys.size).toBe(playbooks.length);
  });
});

describe("findLifeOpsSubscriptionPlaybook", () => {
  it("returns null for empty input", () => {
    expect(findLifeOpsSubscriptionPlaybook(null)).toBeNull();
    expect(findLifeOpsSubscriptionPlaybook(undefined)).toBeNull();
    expect(findLifeOpsSubscriptionPlaybook("")).toBeNull();
  });

  it("matches by exact service name", () => {
    expect(findLifeOpsSubscriptionPlaybook("Netflix")?.key).toBe("netflix");
    expect(findLifeOpsSubscriptionPlaybook("Spotify")?.key).toBe("spotify");
  });

  it("matches by registry key", () => {
    expect(findLifeOpsSubscriptionPlaybook("disney_plus")?.key).toBe(
      "disney_plus",
    );
  });

  it("matches by alias", () => {
    expect(findLifeOpsSubscriptionPlaybook("coursera")?.key).toBe(
      "coursera_plus",
    );
  });

  it("normalizes case, punctuation, and whitespace", () => {
    expect(findLifeOpsSubscriptionPlaybook("  NETFLIX!  ")?.key).toBe(
      "netflix",
    );
    expect(findLifeOpsSubscriptionPlaybook("Disney+")?.key).toBe("disney_plus");
    expect(findLifeOpsSubscriptionPlaybook("Amazon Prime Video")?.key).toBe(
      "amazon_prime_video",
    );
  });

  it("returns null when no playbook matches", () => {
    expect(
      findLifeOpsSubscriptionPlaybook("Definitely Not A Service"),
    ).toBeNull();
  });

  it("does not fuzzy-match a bare substring onto a larger service name", () => {
    // "apple" is a substring of "apple_tv_plus" and "apple_subscriptions",
    // but the fuzzy fallback only fires when the *input* contains a full
    // registered name — a bare fragment must not route the user into a
    // wrong service's cancellation flow.
    expect(findLifeOpsSubscriptionPlaybook("apple")).toBeNull();
  });

  it("matches a service name containing spaces after normalization", () => {
    expect(findLifeOpsSubscriptionPlaybook("Google Play")?.key).toBe(
      "google_play",
    );
  });
});
