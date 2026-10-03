/**
 * Deterministic tests of the pure terminal operating-mode state: parsing of
 * stored records, recorded transitions, the OFF polling rule, and scout
 * ranking.
 */
import { describe, expect, it } from "vitest";
import {
  changeOperatingMode,
  DEFAULT_OPERATING_MODE,
  OPERATING_MODE_HISTORY_LIMIT,
  parseOperatingModeState,
  pollsMarkets,
  rankScoutCandidates,
} from "./operating-mode";

describe("parseOperatingModeState", () => {
  it("starts in SLEEP with no history when nothing is stored", () => {
    expect(parseOperatingModeState(null)).toEqual({
      status: "empty",
      state: { mode: "sleep", history: [] },
    });
    expect(DEFAULT_OPERATING_MODE).toBe("sleep");
  });

  it("round-trips a stored state", () => {
    const state = changeOperatingMode(
      { mode: "sleep", history: [] },
      "hunt",
      1_000,
    );
    expect(parseOperatingModeState(JSON.stringify(state))).toEqual({
      status: "ok",
      state,
    });
  });

  it.each([
    ["{broken", /not valid JSON/],
    [JSON.stringify({ mode: "turbo", history: [] }), /unexpected shape/],
    [JSON.stringify({ mode: "off" }), /unexpected shape/],
    [
      JSON.stringify({ mode: "off", history: [{ from: "sleep", to: "x" }] }),
      /unreadable entry/,
    ],
  ])("restores SLEEP and reports why for %s", (raw, message) => {
    const parsed = parseOperatingModeState(raw);
    expect(parsed.status).toBe("invalid");
    expect(parsed.state).toEqual({ mode: "sleep", history: [] });
    if (parsed.status === "invalid") expect(parsed.error).toMatch(message);
  });
});

describe("changeOperatingMode", () => {
  it("records each change newest first", () => {
    let state = changeOperatingMode({ mode: "sleep", history: [] }, "hunt", 1);
    state = changeOperatingMode(state, "off", 2);
    expect(state.mode).toBe("off");
    expect(state.history).toEqual([
      { from: "hunt", to: "off", at: 2 },
      { from: "sleep", to: "hunt", at: 1 },
    ]);
  });

  it("returns the same state when the mode does not change", () => {
    const state = { mode: "sleep" as const, history: [] };
    expect(changeOperatingMode(state, "sleep", 5)).toBe(state);
  });

  it("keeps a bounded per-browser history", () => {
    let state = changeOperatingMode({ mode: "sleep", history: [] }, "hunt", 0);
    for (let at = 1; at <= OPERATING_MODE_HISTORY_LIMIT + 5; at += 1) {
      state = changeOperatingMode(
        state,
        state.mode === "hunt" ? "sleep" : "hunt",
        at,
      );
    }
    expect(state.history).toHaveLength(OPERATING_MODE_HISTORY_LIMIT);
    expect(state.history[0]?.at).toBe(OPERATING_MODE_HISTORY_LIMIT + 5);
  });
});

describe("pollsMarkets", () => {
  it("stops automatic market requests only when OFF", () => {
    expect(pollsMarkets("hunt")).toBe(true);
    expect(pollsMarkets("sleep")).toBe(true);
    expect(pollsMarkets("off")).toBe(false);
  });
});

describe("rankScoutCandidates", () => {
  const markets = [
    { id: "flat", change24hPct: 0.5 },
    { id: "up", change24hPct: 12 },
    { id: "down", change24hPct: -15 },
    { id: "mild", change24hPct: 3 },
    { id: "bad", change24hPct: Number.NaN },
  ];

  it("ranks the largest moves either way and drops flat assets", () => {
    expect(rankScoutCandidates(markets).map((market) => market.id)).toEqual([
      "down",
      "up",
      "mild",
    ]);
  });

  it("limits the list and returns nothing for a flat market", () => {
    expect(rankScoutCandidates(markets, 1).map((m) => m.id)).toEqual(["down"]);
    expect(rankScoutCandidates([{ id: "flat", change24hPct: 1 }])).toEqual([]);
  });
});
