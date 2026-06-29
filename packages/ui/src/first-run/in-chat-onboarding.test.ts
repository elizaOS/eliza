// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { findChoiceRegions } from "../components/chat/message-choice-parser";
import {
  buildFirstRunSeedMessages,
  consumeFirstRunChoice,
  FIRST_RUN_CHOICE_SCOPE,
  FIRST_RUN_RUNTIME_VALUES,
  isFirstRunChoiceValue,
  isInChatOnboardingEnabled,
  setFirstRunChoiceInterceptor,
} from "./in-chat-onboarding";

afterEach(() => {
  setFirstRunChoiceInterceptor(null);
  try {
    window.localStorage.removeItem("eliza:in-chat-onboarding");
  } catch {
    // jsdom always has localStorage; ignore if a runtime lacks it.
  }
});

describe("buildFirstRunSeedMessages", () => {
  it("seeds a greeting then a runtime CHOICE the live parser accepts", () => {
    const [greeting, choice] = buildFirstRunSeedMessages(1000);

    expect(greeting.role).toBe("assistant");
    expect(greeting.text).toMatch(/hey there! I'm Eliza/i);
    expect(greeting.text).toMatch(/How would you like to run me/i);
    expect(choice.timestamp).toBeGreaterThan(greeting.timestamp);

    const regions = findChoiceRegions(choice.text ?? "");
    expect(regions).toHaveLength(1);
    const region = regions[0];
    expect(region.scope).toBe(FIRST_RUN_CHOICE_SCOPE);
    expect(region.id).toBe("runtime");
    expect(region.allowCustom).toBe(true);
    expect(region.options.map((o) => o.value)).toEqual([
      ...FIRST_RUN_RUNTIME_VALUES,
    ]);
  });

  it("produces stable, deterministic ids for idempotent re-seeding", () => {
    const a = buildFirstRunSeedMessages(1).map((m) => m.id);
    const b = buildFirstRunSeedMessages(999).map((m) => m.id);
    expect(a).toEqual(b);
  });
});

describe("consumeFirstRunChoice", () => {
  it("is a no-op when no interceptor is registered (flag-OFF byte-identical)", () => {
    expect(consumeFirstRunChoice("cloud")).toBe(false);
  });

  it("routes runtime + scoped (provider/agent/tutorial) values to the handler", () => {
    const handler = vi.fn();
    setFirstRunChoiceInterceptor(handler);

    const firstRunValues = [
      ...FIRST_RUN_RUNTIME_VALUES,
      "provider:on-device",
      "provider:elizacloud",
      "agent:abc",
      "agent:new",
      "tutorial:take",
      "tutorial:skip",
    ];
    for (const value of firstRunValues) {
      expect(consumeFirstRunChoice(value)).toBe(true);
    }
    expect(handler).toHaveBeenCalledTimes(firstRunValues.length);

    handler.mockClear();
    expect(consumeFirstRunChoice("hello world")).toBe(false);
    expect(consumeFirstRunChoice("/settings")).toBe(false);
    expect(handler).not.toHaveBeenCalled();
  });

  it("clears the interceptor with null", () => {
    setFirstRunChoiceInterceptor(vi.fn());
    setFirstRunChoiceInterceptor(null);
    expect(consumeFirstRunChoice("local")).toBe(false);
  });
});

describe("isFirstRunChoiceValue", () => {
  it("recognizes runtime + scoped choice values, rejects free text", () => {
    expect(isFirstRunChoiceValue("cloud")).toBe(true);
    expect(isFirstRunChoiceValue("provider:on-device")).toBe(true);
    expect(isFirstRunChoiceValue("agent:new")).toBe(true);
    expect(isFirstRunChoiceValue("tutorial:skip")).toBe(true);
    expect(isFirstRunChoiceValue("hello")).toBe(false);
    expect(isFirstRunChoiceValue("providerish")).toBe(false);
  });
});

describe("isInChatOnboardingEnabled", () => {
  it("defaults to false (legacy full-screen first-run)", () => {
    expect(isInChatOnboardingEnabled()).toBe(false);
  });

  it("is enabled by the localStorage override the e2e harness sets", () => {
    window.localStorage.setItem("eliza:in-chat-onboarding", "1");
    expect(isInChatOnboardingEnabled()).toBe(true);
  });
});
