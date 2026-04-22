import { describe, expect, it } from "vitest";
import type { HandlerRegistration } from "./handler-registry";
import {
  allowLocalGgufAlongsideExternalLlm,
  computeSuppressMiladyLocalGguf,
  hasAlternativeInferenceProviders,
  prefersMiladyLocalInferenceSlot,
} from "./local-gguf-vs-external";
import type { RoutingPreferences } from "./routing-preferences";

function reg(provider: string, priority = 0): HandlerRegistration {
  return {
    modelType: "TEXT_SMALL",
    provider,
    priority,
    registeredAt: new Date().toISOString(),
    handler: async () => "",
  };
}

describe("local-gguf-vs-external", () => {
  const emptyPrefs: RoutingPreferences = { preferredProvider: {}, policy: {} };

  it("suppresses when external ready, user has local intent, and alternatives exist", () => {
    const candidates = [reg("milady-local-inference"), reg("openai", 10)];
    expect(
      computeSuppressMiladyLocalGguf({
        candidates,
        slot: "TEXT_SMALL",
        prefs: emptyPrefs,
        hasExplicitLocalIntent: true,
        externalLocalLlmReady: true,
      }),
    ).toBe(true);
  });

  it("does not suppress without external readiness", () => {
    const candidates = [reg("milady-local-inference"), reg("openai")];
    expect(
      computeSuppressMiladyLocalGguf({
        candidates,
        slot: "TEXT_SMALL",
        prefs: emptyPrefs,
        hasExplicitLocalIntent: true,
        externalLocalLlmReady: false,
      }),
    ).toBe(false);
  });

  it("does not suppress when milady-local is the only handler", () => {
    const candidates = [reg("milady-local-inference")];
    expect(
      computeSuppressMiladyLocalGguf({
        candidates,
        slot: "TEXT_SMALL",
        prefs: emptyPrefs,
        hasExplicitLocalIntent: true,
        externalLocalLlmReady: true,
      }),
    ).toBe(false);
  });

  it("does not suppress without explicit local intent", () => {
    const candidates = [reg("milady-local-inference"), reg("openai")];
    expect(
      computeSuppressMiladyLocalGguf({
        candidates,
        slot: "TEXT_SMALL",
        prefs: emptyPrefs,
        hasExplicitLocalIntent: false,
        externalLocalLlmReady: true,
      }),
    ).toBe(false);
  });

  it("does not suppress when user prefers milady-local-inference", () => {
    const candidates = [reg("milady-local-inference"), reg("openai")];
    const prefs: RoutingPreferences = {
      preferredProvider: { TEXT_SMALL: "milady-local-inference" },
      policy: {},
    };
    expect(prefersMiladyLocalInferenceSlot(prefs, "TEXT_SMALL")).toBe(true);
    expect(
      computeSuppressMiladyLocalGguf({
        candidates,
        slot: "TEXT_SMALL",
        prefs,
        hasExplicitLocalIntent: true,
        externalLocalLlmReady: true,
      }),
    ).toBe(false);
  });

  it("hasAlternativeInferenceProviders is false for local-only", () => {
    expect(
      hasAlternativeInferenceProviders([reg("milady-local-inference")]),
    ).toBe(false);
    expect(
      hasAlternativeInferenceProviders([
        reg("milady-local-inference"),
        reg("ollama"),
      ]),
    ).toBe(true);
  });

  it("allowLocalGgufAlongsideExternalLlm reads env when set", () => {
    const prev = process.env.MILADY_ALLOW_LOCAL_GGUF_WITH_EXTERNAL_LLM;
    try {
      process.env.MILADY_ALLOW_LOCAL_GGUF_WITH_EXTERNAL_LLM = "1";
      expect(allowLocalGgufAlongsideExternalLlm()).toBe(true);
      expect(
        computeSuppressMiladyLocalGguf({
          candidates: [reg("milady-local-inference"), reg("openai")],
          slot: "TEXT_SMALL",
          prefs: emptyPrefs,
          hasExplicitLocalIntent: true,
          externalLocalLlmReady: true,
        }),
      ).toBe(false);
    } finally {
      if (prev === undefined)
        delete process.env.MILADY_ALLOW_LOCAL_GGUF_WITH_EXTERNAL_LLM;
      else process.env.MILADY_ALLOW_LOCAL_GGUF_WITH_EXTERNAL_LLM = prev;
    }
  });
});
