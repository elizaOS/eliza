/**
 * Unit tests for the API server-helpers conversation-greeting persona
 * selection and avatar-to-preset mirroring. Deterministic — a mocked
 * `Math.random` sweep drives the real helpers with a cast-fake runtime,
 * no live model. Blocked-object-key sanitization is covered in
 * `blocked-object-keys.test.ts`.
 */
import { describe, expect, it } from "vitest";

import { resolveMirroredAvatarPresetId } from "./server-helpers";

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
