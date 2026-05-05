import { describe, expect, test } from "vitest";
import {
  findLifeOpsSubscriptionPlaybook,
  listLifeOpsSubscriptionPlaybooks,
} from "../src/lifeops/subscriptions-playbooks.js";

describe("LifeOps subscription playbook registry", () => {
  test("labels executable playbooks separately from management-url manual fallbacks", () => {
    const googlePlay = findLifeOpsSubscriptionPlaybook("Google Play");
    expect(googlePlay?.steps?.length).toBeGreaterThan(0);
    expect(googlePlay?.cancellationCapability).toEqual({
      kind: "executable_playbook",
      label: "Executable cancellation playbook",
      executionSurface: "browser_steps",
      manualFallback: false,
    });

    const netflix = findLifeOpsSubscriptionPlaybook("Netflix");
    expect(netflix?.steps).toBeUndefined();
    expect(netflix?.cancellationCapability).toEqual({
      kind: "management_url_manual_fallback",
      label: "Management URL manual fallback",
      executionSurface: "management_url",
      manualFallback: true,
      reason: "no_verified_click_flow",
    });
  });

  test("keeps capability markers consistent with concrete browser steps", () => {
    for (const playbook of listLifeOpsSubscriptionPlaybooks()) {
      const hasSteps = (playbook.steps?.length ?? 0) > 0;
      expect(playbook.cancellationCapability.kind).toBe(
        hasSteps ? "executable_playbook" : "management_url_manual_fallback",
      );
      expect(playbook.cancellationCapability.manualFallback).toBe(!hasSteps);
    }
  });

  test("does not register duplicate playbook keys", () => {
    const seen = new Set<string>();
    const duplicates = new Set<string>();

    for (const playbook of listLifeOpsSubscriptionPlaybooks()) {
      if (seen.has(playbook.key)) {
        duplicates.add(playbook.key);
      }
      seen.add(playbook.key);
    }

    expect([...duplicates]).toEqual([]);
  });

  test("common unverified services stay management-url-only", () => {
    for (const serviceName of ["Netflix", "Hulu", "Spotify", "ChatGPT Plus"]) {
      const playbook = findLifeOpsSubscriptionPlaybook(serviceName);
      expect(playbook?.steps).toBeUndefined();
      expect(playbook?.cancellationCapability.kind).toBe(
        "management_url_manual_fallback",
      );
      expect(playbook?.cancellationCapability.manualFallback).toBe(true);
    }
  });
});
