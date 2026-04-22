import type {
  LifeOpsActivitySignal,
  LifeOpsAwakeProbability,
  LifeOpsScheduleRegularity,
  LifeOpsSleepCycle,
} from "@elizaos/shared/contracts/lifeops";
import type { LifeOpsActivityWindow } from "./sleep-cycle.js";
import { getZonedDateParts } from "./time.js";

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function round(value: number): number {
  return Math.round(clamp(value, 0, 1) * 100) / 100;
}

function logistic(value: number): number {
  return 1 / (1 + Math.exp(-value));
}

function parseIsoMs(value: string | null | undefined): number | null {
  if (typeof value !== "string" || value.trim().length === 0) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function localHour(nowMs: number, timezone: string): number {
  const parts = getZonedDateParts(new Date(nowMs), timezone);
  return parts.hour + parts.minute / 60;
}

export function computeAwakeProbability(args: {
  nowMs: number;
  timezone: string;
  signals: readonly LifeOpsActivitySignal[];
  windows: readonly LifeOpsActivityWindow[];
  sleepCycle: Pick<
    LifeOpsSleepCycle,
    | "isProbablySleeping"
    | "sleepConfidence"
    | "currentSleepStartedAt"
    | "lastSleepEndedAt"
    | "sleepStatus"
    | "evidence"
  >;
  regularity: LifeOpsScheduleRegularity;
}): LifeOpsAwakeProbability {
  const contributors: LifeOpsAwakeProbability["contributingSources"] = [];
  let llr = 0;

  const latestSignal = [...args.signals]
    .map((signal) => ({
      signal,
      observedAtMs: parseIsoMs(signal.observedAt),
    }))
    .filter(
      (
        candidate,
      ): candidate is { signal: LifeOpsActivitySignal; observedAtMs: number } =>
        candidate.observedAtMs !== null,
    )
    .sort((left, right) => right.observedAtMs - left.observedAtMs)[0];

  if (latestSignal) {
    const ageMs = args.nowMs - latestSignal.observedAtMs;
    const state = latestSignal.signal.state;
    if (state === "active" && ageMs <= 5 * 60_000) {
      contributors.push({
        source: latestSignal.signal.source,
        logLikelihoodRatio: 2.4,
      });
      llr += 2.4;
    } else if (state === "active" && ageMs <= 15 * 60_000) {
      contributors.push({
        source: latestSignal.signal.source,
        logLikelihoodRatio: 1.4,
      });
      llr += 1.4;
    } else if (
      (state === "idle" || state === "locked" || state === "sleeping") &&
      ageMs <= 90 * 60_000
    ) {
      const asleepWeight =
        state === "sleeping" ? -2.2 : state === "locked" ? -1.2 : -0.8;
      contributors.push({
        source: latestSignal.signal.source,
        logLikelihoodRatio: asleepWeight,
      });
      llr += asleepWeight;
    }
  }

  const currentSleepStartMs = parseIsoMs(args.sleepCycle.currentSleepStartedAt);
  if (
    args.sleepCycle.sleepStatus === "sleeping_now" &&
    currentSleepStartMs !== null &&
    args.nowMs >= currentSleepStartMs
  ) {
    const strongestEvidence =
      [...args.sleepCycle.evidence]
        .sort((left, right) => right.confidence - left.confidence)[0]?.source ??
      "activity_gap";
    const sleepWeight = -2.8 * clamp(args.sleepCycle.sleepConfidence, 0.3, 1);
    contributors.push({
      source: strongestEvidence,
      logLikelihoodRatio: sleepWeight,
    });
    llr += sleepWeight;
  }

  const wakeAtMs = parseIsoMs(args.sleepCycle.lastSleepEndedAt);
  if (wakeAtMs !== null) {
    const minutesSinceWake = (args.nowMs - wakeAtMs) / 60_000;
    if (minutesSinceWake >= 0 && minutesSinceWake <= 120) {
      contributors.push({
        source: "health",
        logLikelihoodRatio: 1.6,
      });
      llr += 1.6;
    }
  }

  const latestWindowEndMs =
    args.windows.length > 0 ? args.windows[args.windows.length - 1]?.endMs ?? null : null;
  if (latestWindowEndMs !== null) {
    const gapMinutes = Math.max(0, Math.round((args.nowMs - latestWindowEndMs) / 60_000));
    if (gapMinutes >= 180) {
      const sleepGapWeight = -clamp(gapMinutes / 240, 0.8, 1.8);
      contributors.push({
        source: "activity_gap",
        logLikelihoodRatio: sleepGapWeight,
      });
      llr += sleepGapWeight;
    } else if (gapMinutes <= 15) {
      contributors.push({
        source: "activity_gap",
        logLikelihoodRatio: 0.8,
      });
      llr += 0.8;
    }
  }

  if (args.regularity.regularityClass === "regular" || args.regularity.regularityClass === "very_regular") {
    const hour = localHour(args.nowMs, args.timezone);
    const sleepWindowWeight =
      hour >= 22 || hour < 6
        ? -0.9
        : hour >= 6 && hour < 10
          ? 0.5
          : 0.1;
    const scaledWeight = sleepWindowWeight * clamp(args.regularity.sri / 100, 0.4, 1);
    contributors.push({
      source: "prior",
      logLikelihoodRatio: scaledWeight,
    });
    llr += scaledWeight;
  }

  const signalCoverage = clamp(args.signals.length / 12, 0, 1);
  const windowCoverage = args.windows.length > 0 ? 1 : 0;
  let evidenceCoverage = clamp(
    signalCoverage * 0.7 + windowCoverage * 0.2 + Math.min(contributors.length, 4) * 0.1,
    0.15,
    1,
  );
  if (args.sleepCycle.sleepStatus === "sleeping_now") {
    evidenceCoverage = Math.max(evidenceCoverage, 0.9);
  } else if (wakeAtMs !== null && args.nowMs - wakeAtMs <= 2 * 60 * 60 * 1_000) {
    evidenceCoverage = Math.max(evidenceCoverage, 0.75);
  }
  const pKnown = round(evidenceCoverage);
  const awakeKnown = logistic(llr);
  const pAwake = round(awakeKnown * pKnown);
  const pAsleep = round((1 - awakeKnown) * pKnown);
  const pUnknown = round(clamp(1 - pKnown, 0, 1));
  const total = pAwake + pAsleep + pUnknown;

  if (total <= 0) {
    return {
      pAwake: 0,
      pAsleep: 0,
      pUnknown: 1,
      contributingSources: [],
      computedAt: new Date(args.nowMs).toISOString(),
    };
  }

  return {
    pAwake: round(pAwake / total),
    pAsleep: round(pAsleep / total),
    pUnknown: round(pUnknown / total),
    contributingSources: contributors,
    computedAt: new Date(args.nowMs).toISOString(),
  };
}
