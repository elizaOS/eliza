import { describe, expect, it } from "vitest";
import { VoteLockTable } from "./speaker-identity.js";

describe("VoteLockTable vote-and-lock", () => {
  it("locks a track after 2 votes at ≥70% agreement", () => {
    const t = new VoteLockTable();
    expect(t.recordVote(0, "Alice")).toBeNull(); // 1 vote — not yet
    expect(t.isLocked(0)).toBe(false);
    expect(t.recordVote(0, "Alice")).toBe("Alice"); // 2 votes @ 100% → lock
    expect(t.isLocked(0)).toBe(true);
    expect(t.getLocked(0)).toBe("Alice");
  });

  it("does not lock when agreement is below the 70% ratio", () => {
    const t = new VoteLockTable();
    t.recordVote(0, "Alice");
    t.recordVote(0, "Bob");
    // 1 vs 1 → top ratio 50% < 70%, no lock even though top has < threshold too.
    expect(t.isLocked(0)).toBe(false);
    // Push Alice to 2/3 = 66% — still below 70%.
    t.recordVote(0, "Alice");
    expect(t.isLocked(0)).toBe(false);
    // Alice to 3/4 = 75% ≥ 70% and ≥ threshold → lock.
    t.recordVote(0, "Alice");
    expect(t.getLocked(0)).toBe("Alice");
  });

  it("enforces one-name-per-track / one-track-per-name", () => {
    const t = new VoteLockTable();
    t.recordVote(0, "Alice");
    t.recordVote(0, "Alice");
    expect(t.getLocked(0)).toBe("Alice");
    // Track 1 cannot take Alice — votes are ignored while she is locked to 0.
    expect(t.recordVote(1, "Alice")).toBeNull();
    expect(t.recordVote(1, "Alice")).toBeNull();
    expect(t.isLocked(1)).toBe(false);
    expect(t.isNameTaken("Alice")).toBe(true);
    expect(t.isNameTaken("Alice", 0)).toBe(false); // excluding its own track
  });

  it("ignores further votes once a track is locked", () => {
    const t = new VoteLockTable();
    t.recordVote(0, "Alice");
    t.recordVote(0, "Alice");
    expect(t.recordVote(0, "Bob")).toBeNull();
    expect(t.getLocked(0)).toBe("Alice");
  });

  it("supports fractional (overlapping-speech) weights", () => {
    const t = new VoteLockTable();
    t.recordVote(0, "Alice", 0.5);
    t.recordVote(0, "Bob", 0.5);
    t.recordVote(0, "Alice", 0.5); // Alice 1.0, Bob 0.5 → 66%, no lock
    expect(t.isLocked(0)).toBe(false);
    t.recordVote(0, "Alice", 1.0); // Alice 2.0 / total 2.5 = 80% ≥ threshold+ratio
    expect(t.getLocked(0)).toBe("Alice");
  });

  it("bestGuess returns the leading unclaimed vote before lock", () => {
    const t = new VoteLockTable();
    t.recordVote(0, "Alice", 0.5);
    expect(t.bestGuess(0)).toBe("Alice");
  });

  it("invalidate frees a track for re-mapping (roster change)", () => {
    const t = new VoteLockTable();
    t.recordVote(0, "Alice");
    t.recordVote(0, "Alice");
    expect(t.getLocked(0)).toBe("Alice");
    t.invalidate(0);
    expect(t.isLocked(0)).toBe(false);
    expect(t.isNameTaken("Alice")).toBe(false);
    // Now another track may claim Alice.
    t.recordVote(1, "Alice");
    t.recordVote(1, "Alice");
    expect(t.getLocked(1)).toBe("Alice");
  });
});
