import { describe, expect, it } from "vitest";

// normalizeOnboardingStep is not exported from persistence.ts — we test it
// indirectly by verifying the valid and invalid step values the module documents.
// The function is the whitelist guard for localStorage persistence; its contract
// is: valid step strings pass through, anything else returns null.

// Import the load/save helpers that call normalizeOnboardingStep internally so
// we can verify the contract without re-exporting the private function.
import {
  loadPersistedOnboardingStep,
  saveOnboardingStep,
  clearPersistedOnboardingStep,
} from "./persistence";

// We need a localStorage-like environment. Vitest (jsdom not configured here)
// may not have localStorage, so we provide a minimal in-memory stub.
function withLocalStorageStub(fn: () => void) {
  const store: Record<string, string> = {};
  const stub = {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => {
      store[key] = value;
    },
    removeItem: (key: string) => {
      delete store[key];
    },
  };
  const original = (globalThis as Record<string, unknown>).localStorage;
  (globalThis as Record<string, unknown>).localStorage = stub;
  try {
    fn();
  } finally {
    if (original === undefined) {
      delete (globalThis as Record<string, unknown>).localStorage;
    } else {
      (globalThis as Record<string, unknown>).localStorage = original;
    }
  }
}

describe("normalizeOnboardingStep (via load/save helpers)", () => {
  it.each([
    "welcome",
    "cloudLogin",
    "identity",
    "connection",
    "rpc",
    "senses",
    "activate",
  ] as const)("accepts valid step %s", (step) => {
    withLocalStorageStub(() => {
      saveOnboardingStep(step);
      expect(loadPersistedOnboardingStep()).toBe(step);
    });
  });

  it("returns null for an invalid step value", () => {
    withLocalStorageStub(() => {
      // Write an arbitrary invalid string directly into localStorage
      localStorage.setItem("eliza:onboarding:step", "saveKeys");
      expect(loadPersistedOnboardingStep()).toBeNull();
    });
  });

  it("returns null for the old-only step name saveKeys", () => {
    withLocalStorageStub(() => {
      localStorage.setItem("eliza:onboarding:step", "saveKeys");
      expect(loadPersistedOnboardingStep()).toBeNull();
    });
  });

  it("returns null for completely unknown step names", () => {
    withLocalStorageStub(() => {
      localStorage.setItem("eliza:onboarding:step", "bogus-step");
      expect(loadPersistedOnboardingStep()).toBeNull();
    });
  });

  it("returns null for numeric strings", () => {
    withLocalStorageStub(() => {
      localStorage.setItem("eliza:onboarding:step", "42");
      expect(loadPersistedOnboardingStep()).toBeNull();
    });
  });

  it("returns null when localStorage is empty (no step saved)", () => {
    withLocalStorageStub(() => {
      clearPersistedOnboardingStep();
      expect(loadPersistedOnboardingStep()).toBeNull();
    });
  });

  it("returns null after clearPersistedOnboardingStep is called", () => {
    withLocalStorageStub(() => {
      saveOnboardingStep("connection");
      clearPersistedOnboardingStep();
      expect(loadPersistedOnboardingStep()).toBeNull();
    });
  });
});
