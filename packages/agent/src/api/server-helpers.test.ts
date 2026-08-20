/**
 * Unit tests for the API server-helpers conversation-greeting persona
 * selection and avatar-to-preset mirroring. Deterministic — a mocked
 * `Math.random` sweep drives the real helpers with a cast-fake runtime,
 * no live model. Blocked-object-key sanitization is covered in
 * `blocked-object-keys.test.ts`.
 */
import type { AgentRuntime } from "@elizaos/core";
import { resolveStylePresetById } from "@elizaos/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  resolveConversationGreetingText,
  resolveMirroredAvatarPresetId,
} from "./server-helpers";

describe("resolveConversationGreetingText persona selection", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const makeRuntime = (name: string) =>
    ({ character: { name, postExamples: [] } }) as unknown as AgentRuntime;

  // The greeting is picked at random from the resolved preset's postExamples.
  // Sweep Math.random across every index so the full reachable greeting set is
  // observable — Eliza and Chen share a couple of lines, so a single draw could
  // mask a persona swap.
  const collectGreetings = (
    runtimeName: string,
    uiConfig: { presetId?: string; avatarIndex?: number },
  ): Set<string> => {
    const greetings = new Set<string>();
    for (let step = 0; step < 32; step += 1) {
      vi.spyOn(Math, "random").mockReturnValue(step / 32);
      greetings.add(
        resolveConversationGreetingText(makeRuntime(runtimeName), "en", {
          assistant: { name: runtimeName },
          ...uiConfig,
        }),
      );
      vi.restoreAllMocks();
    }
    return greetings;
  };

  it("greets a default-Eliza config (presetId eliza + shared avatarIndex) as Eliza, not Chen", () => {
    const eliza = resolveStylePresetById("eliza");
    expect(eliza).toBeDefined();
    const greetings = collectGreetings("Eliza", {
      presetId: "eliza",
      avatarIndex: eliza?.avatarIndex,
    });
    expect(greetings).toEqual(new Set(eliza?.postExamples));
  });

  it("keeps Chen's greeting for a Chen config sharing the same avatarIndex", () => {
    const chen = resolveStylePresetById("chen");
    expect(chen).toBeDefined();
    const greetings = collectGreetings("Chen", {
      presetId: "chen",
      avatarIndex: chen?.avatarIndex,
    });
    expect(greetings).toEqual(new Set(chen?.postExamples));
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
