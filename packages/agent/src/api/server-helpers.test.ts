import type { AgentRuntime } from "@elizaos/core";
import { resolveStylePresetById } from "@elizaos/shared/character-presets";
import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";

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

describe("resolveConversationGreetingText persona resolution", () => {
  it("greets as Eliza for a consistent default-Eliza config (presetId eliza + shared avatarIndex 1)", () => {
    const eliza = resolveStylePresetById("eliza");
    const chen = resolveStylePresetById("chen");
    if (!eliza || !chen) {
      throw new Error("expected eliza and chen presets to exist");
    }
    // The scenario only exists because both personas share avatarIndex 1 —
    // the id must win over the ambiguous art-asset index.
    expect(eliza.avatarIndex).toBe(chen.avatarIndex);

    const runtime = {
      character: { name: "Eliza", postExamples: [] },
    } as unknown as AgentRuntime;

    // Sweep the greeting RNG across every pick slot so the full greeting set
    // is observed deterministically.
    const randomSpy = vi.spyOn(Math, "random");
    const produced = new Set<string>();
    try {
      const steps = 64;
      for (let i = 0; i < steps; i++) {
        randomSpy.mockReturnValue(i / steps);
        produced.add(
          resolveConversationGreetingText(runtime, "en", {
            presetId: "eliza",
            avatarIndex: 1,
          }),
        );
      }
    } finally {
      randomSpy.mockRestore();
    }

    const elizaGreetings = new Set(
      eliza.postExamples.map((value) => value.trim()),
    );
    expect([...produced].sort()).toEqual([...elizaGreetings].sort());
  });
});

describe("resolveMirroredAvatarPresetId", () => {
  it("keeps an already-consistent persisted presetId for a shared avatar index", () => {
    // chen and eliza intentionally share avatarIndex 1 — mirroring the shared
    // index must not rewrite either persona to its sibling.
    expect(resolveMirroredAvatarPresetId(1, "chen")).toBe("chen");
    expect(resolveMirroredAvatarPresetId(1, "eliza")).toBe("eliza");
  });

  it("derives first-wins from the index when no presetId is persisted", () => {
    expect(resolveMirroredAvatarPresetId(1, undefined)).toBe("eliza");
  });

  it("re-derives from the index when the persisted presetId points at another avatar", () => {
    const jin = resolveStylePresetById("jin");
    if (!jin) {
      throw new Error("expected jin preset to exist");
    }
    expect(resolveMirroredAvatarPresetId(jin.avatarIndex, "eliza")).toBe("jin");
  });
});
