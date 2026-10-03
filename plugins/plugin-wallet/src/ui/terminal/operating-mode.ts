/**
 * The terminal's HUNT / SLEEP / OFF operating state and its change history,
 * as pure functions over a plain persisted record.
 *
 * SLEEP is the default: live prices refresh, price alerts are checked, and
 * open paper limit orders settle, but nothing is ranked or suggested. HUNT
 * adds the scout, which ranks live movers for review. OFF stops every
 * automatic market request and pauses price alerts; prices load only when the
 * user asks. No state signs, submits, or places an order on its own. A mode
 * changes only through {@link changeOperatingMode}, which records each change
 * so the history shows who moved the terminal into which state.
 */

export type TerminalOperatingMode = "hunt" | "sleep" | "off";

export const DEFAULT_OPERATING_MODE: TerminalOperatingMode = "sleep";

/** Changes retained in the per-browser history shown in the terminal. */
export const OPERATING_MODE_HISTORY_LIMIT = 50;

export interface OperatingModeChange {
  from: TerminalOperatingMode;
  to: TerminalOperatingMode;
  /** Epoch milliseconds. */
  at: number;
}

export interface OperatingModeState {
  mode: TerminalOperatingMode;
  /** Newest first. */
  history: OperatingModeChange[];
}

export type ParsedOperatingModeState =
  | { status: "empty" | "ok"; state: OperatingModeState }
  | { status: "invalid"; state: OperatingModeState; error: string };

export const OPERATING_MODES: ReadonlyArray<{
  value: TerminalOperatingMode;
  label: string;
  summary: string;
}> = [
  {
    value: "hunt",
    label: "Hunt",
    summary:
      "Live prices refresh, price alerts stay on, and the scout ranks today's biggest movers for you to review. Nothing is bought for you.",
  },
  {
    value: "sleep",
    label: "Sleep",
    summary:
      "Live prices refresh, price alerts stay on, and open paper limit orders settle. No scouting.",
  },
  {
    value: "off",
    label: "Off",
    summary:
      "Automatic market requests stop and price alerts pause. Prices load only when you refresh, and every paper order is manual.",
  },
];

function isMode(value: unknown): value is TerminalOperatingMode {
  return value === "hunt" || value === "sleep" || value === "off";
}

function freshState(): OperatingModeState {
  return { mode: DEFAULT_OPERATING_MODE, history: [] };
}

/** Parse stored state; anything unreadable restarts in SLEEP and says why. */
export function parseOperatingModeState(
  raw: string | null,
): ParsedOperatingModeState {
  if (raw === null) return { status: "empty", state: freshState() };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    // error-policy:J3 an unreadable record becomes an explicit invalid result.
    return {
      status: "invalid",
      state: freshState(),
      error: "Saved terminal mode was not valid JSON",
    };
  }
  if (
    typeof value !== "object" ||
    value === null ||
    !isMode((value as { mode?: unknown }).mode) ||
    !Array.isArray((value as { history?: unknown }).history)
  ) {
    return {
      status: "invalid",
      state: freshState(),
      error: "Saved terminal mode had an unexpected shape",
    };
  }
  const record = value as { mode: TerminalOperatingMode; history: unknown[] };
  const history: OperatingModeChange[] = [];
  for (const entry of record.history) {
    const change = entry as Partial<OperatingModeChange> | null;
    if (
      !change ||
      !isMode(change.from) ||
      !isMode(change.to) ||
      typeof change.at !== "number" ||
      !Number.isFinite(change.at)
    ) {
      return {
        status: "invalid",
        state: freshState(),
        error: "Saved terminal mode history had an unreadable entry",
      };
    }
    history.push({ from: change.from, to: change.to, at: change.at });
  }
  return { status: "ok", state: { mode: record.mode, history } };
}

/** Move to `to`, recording the change; a no-op when already in that mode. */
export function changeOperatingMode(
  state: OperatingModeState,
  to: TerminalOperatingMode,
  at: number,
): OperatingModeState {
  if (state.mode === to) return state;
  return {
    mode: to,
    history: [{ from: state.mode, to, at }, ...state.history].slice(
      0,
      OPERATING_MODE_HISTORY_LIMIT,
    ),
  };
}

/** Whether the terminal may request market data without a user action. */
export function pollsMarkets(mode: TerminalOperatingMode): boolean {
  return mode !== "off";
}

/** A live market row the scout can rank. */
export interface ScoutCandidate {
  id: string;
  change24hPct: number;
}

/**
 * Rank the largest 24h moves, up or down, for review in HUNT. Assets that
 * moved less than `minMovePct` are left out, so a flat market yields an empty
 * list rather than noise presented as signal.
 */
export function rankScoutCandidates<T extends ScoutCandidate>(
  markets: readonly T[],
  count = 5,
  minMovePct = 2,
): T[] {
  return markets
    .filter(
      (market) =>
        Number.isFinite(market.change24hPct) &&
        Math.abs(market.change24hPct) >= minMovePct,
    )
    .sort(
      (left, right) =>
        Math.abs(right.change24hPct) - Math.abs(left.change24hPct),
    )
    .slice(0, count);
}
