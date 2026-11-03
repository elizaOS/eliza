import { LIMITS, type Limits } from "./limits.ts";

export type PresetName = "safe" | "balanced" | "aggressive";

export interface UserSettings {
  preset: PresetName;
  ticketMinSol: number;
  ticketMaxSol: number;
  lanes: number;
  stopLossPct: number;
  takeProfitPct: number;
  takeProfitPartial: number;
  takeProfitFloor: number;
  maxHoldMin: number;
  cooldownMin: number;
  dailyLossPct: number;
  runUntil: string | null;
  alerts: boolean;
  autoLockMin: number;
}

export const DEFAULT_SETTINGS: UserSettings = {
  preset: "balanced",
  ticketMinSol: 0.0125,
  ticketMaxSol: 0.025,
  lanes: 8,
  stopLossPct: -0.08,
  takeProfitPct: 0.15,
  takeProfitPartial: 0.75,
  takeProfitFloor: 0.03,
  maxHoldMin: 20,
  cooldownMin: 5,
  dailyLossPct: 0.1,
  runUntil: null,
  alerts: true,
  autoLockMin: 15,
};

const PRESETS: Record<PresetName, Partial<UserSettings>> = {
  safe: {
    ticketMaxSol: 0.015,
    lanes: 4,
    stopLossPct: -0.06,
    takeProfitPct: 0.12,
    dailyLossPct: 0.08,
    maxHoldMin: 12,
    cooldownMin: 15,
  },
  balanced: {
    ticketMaxSol: 0.025,
    lanes: 8,
    stopLossPct: -0.08,
    takeProfitPct: 0.15,
    dailyLossPct: 0.1,
    maxHoldMin: 20,
    cooldownMin: 5,
  },
  aggressive: {
    ticketMaxSol: 0.04,
    lanes: 8,
    stopLossPct: -0.12,
    takeProfitPct: 0.2,
    dailyLossPct: 0.15,
    maxHoldMin: 30,
    cooldownMin: 3,
  },
};

export interface SettingsError {
  ok: false;
  errors: string[];
}

function num(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function bound(name: string, value: number, min: number, max: number, errors: string[]): number {
  if (value < min || value > max) {
    errors.push(`${name} must be between ${min} and ${max}`);
    return Math.min(max, Math.max(min, value));
  }
  return value;
}

/** Reject out-of-range controls. Rug and manipulation checks are not settings. */
export function parseSettings(
  input: unknown,
  current: UserSettings = DEFAULT_SETTINGS
): UserSettings | SettingsError {
  const src = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const errors: string[] = [];
  const presetRaw = String(src.preset ?? current.preset);
  const preset: PresetName =
    presetRaw === "safe" || presetRaw === "aggressive" || presetRaw === "balanced"
      ? presetRaw
      : current.preset;
  if (
    src.preset != null &&
    presetRaw !== "safe" &&
    presetRaw !== "balanced" &&
    presetRaw !== "aggressive"
  ) {
    errors.push("preset must be safe, balanced, or aggressive");
  }
  const base = { ...current, ...PRESETS[preset] };
  const ticketMinSol = bound(
    "min buy",
    num(src.ticketMinSol, base.ticketMinSol),
    0.0125,
    0.05,
    errors
  );
  let ticketMaxSol = bound(
    "max buy",
    num(src.ticketMaxSol, base.ticketMaxSol),
    0.0125,
    0.1,
    errors
  );
  if (ticketMaxSol < ticketMinSol) {
    errors.push("max buy must be at least the min buy");
    ticketMaxSol = ticketMinSol;
  }
  const stopLossPct = bound(
    "stop-loss",
    num(src.stopLossPct, base.stopLossPct),
    -0.25,
    -0.05,
    errors
  );
  const takeProfitPct = bound(
    "take-profit",
    num(src.takeProfitPct, base.takeProfitPct),
    0.06,
    0.5,
    errors
  );
  const takeProfitPartial = bound(
    "take-profit sell fraction",
    num(src.takeProfitPartial, base.takeProfitPartial),
    0.25,
    1,
    errors
  );
  let takeProfitFloor = bound(
    "profit floor",
    num(src.takeProfitFloor, base.takeProfitFloor),
    0.01,
    0.2,
    errors
  );
  if (!(takeProfitFloor < takeProfitPct)) {
    errors.push("profit floor must be below the take-profit");
    takeProfitFloor = Math.min(takeProfitFloor, takeProfitPct / 2);
  }
  let runUntil: string | null = current.runUntil;
  if (src.runUntil === null || src.runUntil === "") runUntil = null;
  else if (typeof src.runUntil === "string") {
    const t = Date.parse(src.runUntil);
    if (!Number.isFinite(t)) errors.push("run timer must be a time");
    else runUntil = new Date(t).toISOString();
  }
  const lanes = Math.round(bound("lanes", num(src.lanes, base.lanes), 1, 8, errors));
  const maxHoldMin = Math.round(
    bound("max hold minutes", num(src.maxHoldMin, base.maxHoldMin), 5, 60, errors)
  );
  const cooldownMin = Math.round(
    bound("cooldown minutes", num(src.cooldownMin, base.cooldownMin), 1, 1440, errors)
  );
  const dailyLossPct = bound(
    "daily loss limit",
    num(src.dailyLossPct, base.dailyLossPct),
    0.05,
    0.25,
    errors
  );
  const autoLockMin = Math.round(
    bound("auto-lock minutes", num(src.autoLockMin, base.autoLockMin), 1, 120, errors)
  );
  if (errors.length) return { ok: false, errors };
  return {
    preset,
    ticketMinSol,
    ticketMaxSol,
    lanes,
    stopLossPct,
    takeProfitPct,
    takeProfitPartial,
    takeProfitFloor,
    maxHoldMin,
    cooldownMin,
    dailyLossPct,
    runUntil,
    alerts: src.alerts == null ? base.alerts : Boolean(src.alerts),
    autoLockMin,
  };
}

export function applyPreset(
  name: PresetName,
  current: UserSettings = DEFAULT_SETTINGS
): UserSettings {
  const next = parseSettings({ ...current, ...PRESETS[name], preset: name }, current);
  if ("ok" in next) return current;
  return next;
}

const LIQUIDITY: Record<PresetName, number> = { safe: 20_000, balanced: 10_000, aggressive: 8_000 };

/** User knobs change size and exits only. Safety gates stay on. */
export function limitsFromSettings(settings: UserSettings): Limits {
  const holdMs = settings.maxHoldMin * 60_000;
  const stop = settings.stopLossPct;
  return {
    ...LIMITS,
    dynMinTicketSol: settings.ticketMinSol,
    ticketSolFloor: settings.ticketMinSol,
    ticketSolMax: settings.ticketMaxSol,
    maxOpenPositionsCap: settings.lanes,
    stopLossPct: stop,
    pumpSlPct: stop,
    waveSlPct: stop,
    surgeSlPct: stop,
    riskSlPct: stop,
    maxHoldMs: holdMs,
    pumpMaxHoldMs: holdMs,
    xMaxHoldMs: holdMs,
    gradMaxHoldMs: holdMs,
    mrMaxHoldMs: holdMs,
    jupMaxHoldMs: holdMs,
    waveMaxHoldMs: holdMs,
    riskMaxHoldMs: holdMs,
    rebuyCooldownMs: settings.cooldownMin * 60_000,
    dailyLossCapPct: settings.dailyLossPct,
    minLiquidityUsd: LIQUIDITY[settings.preset],
    userTpThreshold: settings.takeProfitPct,
    userTpPartial: settings.takeProfitPartial,
    userTpFloor: settings.takeProfitFloor,
  };
}
