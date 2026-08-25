import { describe, expect, it, vi } from "vitest";
import {
  buildReplayContext,
  partialAnswersFromFacts,
  relationshipsFallbackForReplay,
} from "./replay";

const fullFacts = {
  preferredName: { value: "Alex", provenance: "owner" },
  timezone: { value: "America/New_York", provenance: "owner" },
  morningWindow: {
    value: {
      startLocal: "06:30",
      endLocal: "10:00",
      timezone: "America/New_York",
    },
    provenance: "owner",
  },
  eveningWindow: {
    value: {
      startLocal: "19:00",
      endLocal: "23:00",
      timezone: "America/New_York",
    },
    provenance: "owner",
  },
  preferredNotificationChannel: { value: "push", provenance: "owner" },
};

describe("partialAnswersFromFacts", () => {
  it("projects every known fact into the partial answers shape", () => {
    const partial = partialAnswersFromFacts(fullFacts);
    expect(partial).toEqual({
      preferredName: "Alex",
      timezone: "America/New_York",
      morningWindow: { startLocal: "06:30", endLocal: "10:00" },
      eveningWindow: { startLocal: "19:00", endLocal: "23:00" },
      channel: "push",
    });
  });

  it("keeps missing facts missing instead of inventing defaults", () => {
    const partial = partialAnswersFromFacts({});
    expect(partial).toEqual({});
    expect(partial.preferredName).toBeUndefined();
    expect(partial.timezone).toBeUndefined();
    expect(partial.morningWindow).toBeUndefined();
    expect(partial.channel).toBeUndefined();
  });

  it("maps windows to local start/end only, dropping the timezone field", () => {
    const partial = partialAnswersFromFacts({
      morningWindow: fullFacts.morningWindow,
    });
    expect(partial.morningWindow).toEqual({
      startLocal: "06:30",
      endLocal: "10:00",
    });
    expect(partial.morningWindow?.timezone).toBeUndefined();
  });

  it("maps only the facts that are present in a sparse fact set", () => {
    const partial = partialAnswersFromFacts({
      preferredName: fullFacts.preferredName,
      eveningWindow: fullFacts.eveningWindow,
    });
    expect(partial.preferredName).toBe("Alex");
    expect(partial.eveningWindow).toEqual({
      startLocal: "19:00",
      endLocal: "23:00",
    });
    expect(partial.timezone).toBeUndefined();
    expect(partial.channel).toBeUndefined();
  });
});

describe("relationshipsFallbackForReplay", () => {
  it("starts the relationship question as a fresh round", () => {
    expect(relationshipsFallbackForReplay()).toEqual([]);
  });
});

describe("buildReplayContext", () => {
  it("surfaces current facts as the replay defaults payload", async () => {
    const store = { read: vi.fn(async () => fullFacts) };
    await expect(buildReplayContext(store)).resolves.toEqual({
      currentFacts: fullFacts,
    });
    expect(store.read).toHaveBeenCalledTimes(1);
  });
});
