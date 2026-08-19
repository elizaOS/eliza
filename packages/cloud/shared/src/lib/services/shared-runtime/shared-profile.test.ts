/**
 * Exercises deterministic Shared profile extraction and durable marker hygiene
 * without model mocks so privacy and precedence behavior stays reproducible.
 */

import { describe, expect, it } from "vitest";
import {
  applySharedProfileMutation,
  extractSharedProfileMutation,
  formatSharedProfile,
  mergeSharedChannelIdentityHint,
  mergeSharedProfileHint,
  missingSharedProfileFields,
  readSharedProfile,
  sharedProfileProviderProjection,
  upsertSharedProfileMessage,
  withoutSharedProfileMessages,
} from "./shared-profile";

const EMPTY = { version: 1 as const, facts: {} };

describe("Shared owner profile", () => {
  it("captures Unicode names, stable home location, and valid timezone explicitly", () => {
    const profile = applySharedProfileMutation(
      EMPTY,
      extractSharedProfileMutation(
        "Call me José Álvarez. I live in Montréal. My timezone is America/Toronto.",
        "2026-08-19T00:00:00.000Z",
      ),
    );

    expect(profile.facts.preferredName).toMatchObject({
      value: "José Álvarez",
      source: "owner_explicit",
    });
    expect(profile.facts.location?.value).toBe("Montréal");
    expect(profile.facts.timezone?.value).toBe("America/Toronto");
  });

  it("does not turn transient presence or ambiguous timezone abbreviations into facts", () => {
    const mutation = extractSharedProfileMutation("I'm in Tokyo today and my timezone is CST.");
    expect(mutation.set.location).toBeUndefined();
    expect(mutation.set.timezone).toBeUndefined();
  });

  it("supports explicit correction and deletion", () => {
    const named = applySharedProfileMutation(EMPTY, extractSharedProfileMutation("Call me Nia"));
    const corrected = applySharedProfileMutation(
      named,
      extractSharedProfileMutation("Actually, call me Niamh"),
    );
    const forgotten = applySharedProfileMutation(
      corrected,
      extractSharedProfileMutation("Forget my preferred name."),
    );

    expect(corrected.facts.preferredName?.value).toBe("Niamh");
    expect(forgotten.facts.preferredName).toBeUndefined();
  });

  it("never lets a coarse hint overwrite an explicit fact", () => {
    const explicit = applySharedProfileMutation(
      EMPTY,
      extractSharedProfileMutation("I live in Oakland"),
    );
    const hinted = mergeSharedProfileHint(explicit, "location", {
      value: "San Francisco Bay Area",
      source: "network_inferred",
      confidence: 0.4,
      recordedAt: "2026-08-19T00:00:00.000Z",
    });
    expect(hinted).toBe(explicit);
    expect(hinted.facts.location?.value).toBe("Oakland");
  });

  it("accepts only a bounded channel display-name hint at fixed confidence", () => {
    const hinted = mergeSharedChannelIdentityHint(
      EMPTY,
      { preferredName: "  Nia   Chen  " },
      "2026-08-19T00:00:00.000Z",
    );

    expect(hinted.facts).toEqual({
      preferredName: {
        value: "Nia Chen",
        source: "channel_identity",
        confidence: 0.8,
        recordedAt: "2026-08-19T00:00:00.000Z",
      },
    });
    expect(
      mergeSharedChannelIdentityHint(EMPTY, {
        preferredName: "x".repeat(129),
      }),
    ).toBe(EMPTY);
  });

  it("never lets a channel display name overwrite an owner-explicit name", () => {
    const explicit = applySharedProfileMutation(
      EMPTY,
      extractSharedProfileMutation("Call me Niamh"),
    );
    const hinted = mergeSharedChannelIdentityHint(explicit, {
      preferredName: "Discord Nickname",
    });

    expect(hinted).toBe(explicit);
    expect(hinted.facts.preferredName?.value).toBe("Niamh");
  });

  it("round-trips one synthetic marker while excluding its raw contents from model history", () => {
    const profile = applySharedProfileMutation(EMPTY, extractSharedProfileMutation("Call me 李华"));
    const history = upsertSharedProfileMessage([{ role: "user", content: "hello" }], profile);

    expect(readSharedProfile(history)).toEqual(profile);
    expect(withoutSharedProfileMessages(history)).toEqual([{ role: "user", content: "hello" }]);
    expect(formatSharedProfile(profile)).toContain('preferredName: "李华"');
    expect(missingSharedProfileFields(profile)).toEqual(["location", "timezone"]);
    expect(formatSharedProfile(profile)).toContain(
      "Missing fields: location, timezone. Acquire progressively only when contextually useful; never run a survey.",
    );
    expect(sharedProfileProviderProjection(profile).data.missingOwnerProfileFields).toEqual([
      "location",
      "timezone",
    ]);
    expect(sharedProfileProviderProjection(profile).values.missingOwnerProfileFields).toBe(
      "location, timezone",
    );
  });

  it("persists an empty marker after the owner forgets their final fact", () => {
    const named = applySharedProfileMutation(EMPTY, extractSharedProfileMutation("Call me Nia"));
    const forgotten = applySharedProfileMutation(
      named,
      extractSharedProfileMutation("Forget my preferred name."),
    );
    const history = upsertSharedProfileMessage(
      upsertSharedProfileMessage([{ role: "user", content: "hello" }], named),
      forgotten,
    );

    expect(readSharedProfile(history)).toEqual({
      ...EMPTY,
      suppressedHints: ["preferredName"],
    });
    expect(history.filter((message) => message.id === "shared-profile-v1")).toHaveLength(1);
    expect(withoutSharedProfileMessages(history)).toEqual([{ role: "user", content: "hello" }]);
  });

  it("does not restore an explicitly forgotten name from a later channel hint", () => {
    const hinted = mergeSharedChannelIdentityHint(EMPTY, { preferredName: "Channel Nia" });
    const forgotten = applySharedProfileMutation(
      hinted,
      extractSharedProfileMutation("Forget my preferred name."),
    );
    const rehydrated = mergeSharedChannelIdentityHint(forgotten, {
      preferredName: "Channel Nia",
    });
    const replaced = applySharedProfileMutation(
      rehydrated,
      extractSharedProfileMutation("Call me Niamh"),
    );

    expect(rehydrated.facts.preferredName).toBeUndefined();
    expect(rehydrated.suppressedHints).toContain("preferredName");
    expect(replaced.facts.preferredName?.value).toBe("Niamh");
    expect(replaced.suppressedHints).toBeUndefined();
  });
});
