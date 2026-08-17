/**
 * Unit and property tests for the API server-helpers: prototype-pollution key
 * sanitization, conversation-greeting persona selection, and avatar-to-preset
 * mirroring. Deterministic — fast-check fuzzing and a mocked `Math.random`
 * sweep drive the real helpers with a cast-fake runtime, no live model.
 */
import type { AgentRuntime } from "@elizaos/core";
import { resolveStylePresetById } from "@elizaos/shared";
import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  cloneWithoutBlockedObjectKeys,
  hasBlockedObjectKeyDeep,
  resolveConversationGreetingText,
  resolveMirroredAvatarPresetId,
} from "./server-helpers";

describe("blocked object key sanitization", () => {
  it("detects and removes nested prototype-pollution keys without mutating safe data", () => {
    const hostile = JSON.parse(
      '{"safe":{"value":1},"items":[{"constructor":{"prototype":{"polluted":true}}}],"prototype":"x"}',
    ) as Record<string, unknown>;

    expect(hasBlockedObjectKeyDeep(hostile)).toBe(true);

    const clean = cloneWithoutBlockedObjectKeys(hostile);

    expect(clean).toEqual({
      safe: { value: 1 },
      items: [{}],
    });
    expect(hasBlockedObjectKeyDeep(clean)).toBe(false);
    expect(hostile).toHaveProperty("prototype", "x");
  });

  it("does not assign __proto__ while cloning hostile parsed JSON", () => {
    const hostile = JSON.parse(
      '{"__proto__":{"polluted":true},"nested":{"ok":true}}',
    ) as Record<string, unknown>;

    const clean = cloneWithoutBlockedObjectKeys(hostile) as Record<
      string,
      unknown
    >;

    expect(Object.hasOwn(clean, "__proto__")).toBe(false);
    expect(clean).toEqual({ nested: { ok: true } });
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it("fuzzes JSON-compatible values with blocked keys injected at arbitrary leaves", () => {
    fc.assert(
      fc.property(
        // The "legit" value must not itself contain blocked keys, otherwise the
        // sanitizer correctly strips them and clean !== the original value.
        fc.jsonValue().filter((v) => !hasBlockedObjectKeyDeep(v)),
        fc.constantFrom("__proto__", "constructor", "prototype"),
        (value, blockedKey) => {
          const payload = {
            value,
            wrapper: [{ [blockedKey]: { value: "drop me" } }],
          };

          expect(hasBlockedObjectKeyDeep(payload)).toBe(true);
          const clean = cloneWithoutBlockedObjectKeys(payload);
          const cleanValue = cloneWithoutBlockedObjectKeys(value);
          expect(hasBlockedObjectKeyDeep(clean)).toBe(false);
          expect(clean).toEqual({
            value: cleanValue,
            wrapper: [{}],
          });
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe("resolveConversationGreetingText persona selection", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const makeRuntime = (name: string) =>
    ({ character: { name, postExamples: [] } }) as unknown as AgentRuntime;

  const greetingFor = (
    runtimeName: string,
    uiConfig: { presetId?: string; avatarIndex?: number },
  ): string =>
    resolveConversationGreetingText(makeRuntime(runtimeName), "en", {
      assistant: { name: runtimeName },
      ...uiConfig,
    });

  it("greets a default-Eliza config (presetId eliza + shared avatarIndex) as Eliza, not Chen", () => {
    const eliza = resolveStylePresetById("eliza");
    expect(eliza).toBeDefined();
    const greeting = greetingFor("Eliza", {
      presetId: "eliza",
      avatarIndex: eliza?.avatarIndex,
    });
    expect(greeting).toBe(eliza?.catchphrase);
    expect(eliza?.postExamples).not.toContain(greeting);
  });

  it("keeps Chen's greeting for a Chen config sharing the same avatarIndex", () => {
    const chen = resolveStylePresetById("chen");
    expect(chen).toBeDefined();
    const greeting = greetingFor("Chen", {
      presetId: "chen",
      avatarIndex: chen?.avatarIndex,
    });
    expect(greeting).toBe(chen?.catchphrase);
    expect(chen?.postExamples).not.toContain(greeting);
  });

  it("never promotes a custom character post example into a chat greeting", () => {
    const runtime = {
      character: {
        name: "Custom",
        postExamples: ["You need to close 40 tabs."],
      },
    } as unknown as AgentRuntime;

    expect(resolveConversationGreetingText(runtime, "en")).toBe(
      "Hey, I'm Custom. What can I help you with?",
    );
  });
});

describe("resolveMirroredAvatarPresetId", () => {
  it("keeps a persisted presetId that is consistent with the selected avatar", () => {
    expect(resolveMirroredAvatarPresetId("chen", 1)).toBe("chen");
    expect(resolveMirroredAvatarPresetId("eliza", 1)).toBe("eliza");
  });

  it("derives the default persona for an unnamed or inconsistent config", () => {
    expect(resolveMirroredAvatarPresetId(undefined, 1)).toBe("eliza");
    // jin renders asset 2 — selecting avatar 1 means the persisted id no
    // longer matches, so the id is re-derived from the index (default-first).
    expect(resolveMirroredAvatarPresetId("jin", 1)).toBe("eliza");
    expect(resolveMirroredAvatarPresetId("chen", 2)).toBe("jin");
  });
});
