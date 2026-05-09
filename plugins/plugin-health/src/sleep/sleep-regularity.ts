import type {
  LifeOpsPersonalBaseline,
  LifeOpsScheduleRegularity,
  LifeOpsSleepCycleType,
} from "@elizaos/shared";
import { getZonedDateParts } from "../util/time.js";
import { parseIsoMs } from "../util/time-util.js";

export interface SleepRegularityEpisodeLike {
  startAt: string;
  endAt: string | null;
  cycleType: LifeOpsSleepCycleType;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function round(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.round(value * 100) / 100;
}

function durationMinutes(startMs: number, endMs: number): number {
  return Math.max(0, Math.round((endMs - startMs) / 60_000));
}

function isRegularityEpisode(
  episode: SleepRegularityEpisodeLike,
  nowMs: number,
): episode is SleepRegularityEpisodeLike & { endAt: string } {
  const startMs = parseIsoMs(episode.startAt);
  const endMs = parseIsoMs(episode.endAt);
  if (startMs === null || endMs === null || endMs <= startMs || endMs > nowMs) {
    return false;
  }
  if (episode.cycleType === "nap") {
    return false;
  }
  return durationMinutes(startMs, endMs) >= 180;
}

function localMinuteOfDay(ms: number, timezone: string): number {
  const parts = getZonedDateParts(new Date(ms), timezone);
  return parts.hour * 60 + parts.minute;
}

function circularStddevMinutes(minuteValues: readonly number[]): number {
  if (minuteValues.length === 0) {
    return 0;
  }
  const angleScale = (2 * Math.PI) / (24 * 60);
  let sumSin = 0;
  let sumCos = 0;
  for (const minute of minuteValues) {
    const angle = minute * angleScale;
    sumSin += Math.sin(angle);
    sumCos += Math.cos(angle);
  }
  const meanSin = sumSin / minuteValues.length;
  const meanCos = sumCos / minuteValues.length;
  const meanResultantLength = Math.sqrt(meanSin ** 2 + meanCos ** 2);
  if (meanResultantLength <= 0) {
    return 720;
  }
  const stddevRadians = Math.sqrt(-2 * Math.log(meanResultantLength));
  return round(stddevRadians / angleScale);
}

function occupancyVector(args: {
  episodes: Array<SleepRegularityEpisodeLike & { endAt: string }>;
  nowMs: number;
  windowDays: number;
}): { occupied: boolean[]; windowStartMs: number } {
  const totalMinutes = args.windowDays * 24 * 60;
  const windowEndMs = args.nowMs;
  const windowStartMs = windowEndMs - totalMinutes * 60_000;
  const deltas = new Int16Array(totalMinutes + 1);

  for (const episode of args.episodes) {
    const startMs = parseIsoMs(episode.startAt);
    const endMs = parseIsoMs(episode.endAt);
    if (startMs === null || endMs === null) {
      continue;
    }
    const clampedStartMs = Math.max(startMs, windowStartMs);
    const clampedEndMs = Math.min(endMs, windowEndMs);
    if (clampedEndMs <= clampedStartMs) {
      continue;
    }
    const startIndex = Math.max(
      0,
      Math.floor((clampedStartMs - windowStartMs) / 60_000),
    );
    const endIndex = Math.min(
      totalMinutes,
      Math.ceil((clampedEndMs - windowStartMs) / 60_000),
    );
    deltas[startIndex] += 1;
    deltas[endIndex] -= 1;
  }

  const occupied = new Array<boolean>(totalMinutes);
  let activeCount = 0;
  for (let index = 0; index < totalMinutes; index += 1) {
    activeCount += deltas[index] ?? 0;
    occupied[index] = activeCount > 0;
  }
  return { occupied, windowStartMs };
}

function computeSleepRegularityIndex(args: {
  episodes: Array<SleepRegularityEpisodeLike & { endAt: string }>;
  nowMs: number;
  windowDays: number;
}): number {
  const totalMinutes = args.windowDays * 24 * 60;
  if (totalMinutes <= 24 * 60) {
    return 0;
  }
  const { occupied } = occupancyVector(args);
  let matches = 0;
  let comparisons = 0;
  const oneDayMinutes = 24 * 60;
  for (let index = 0; index < occupied.length - oneDayMinutes; index += 1) {
    matches += occupied[index] === occupied[index + oneDayMinutes] ? 1 : 0;
    comparisons += 1;
  }
  if (comparisons === 0) {
    return 0;
  }
  const agreement = matches / comparisons;
  return round(clamp(200 * agreement - 100, 0, 100));
}

function classifyRegularity(args: {
  sampleCount: number;
  sri: number;
  bedtimeStddevMin: number;
  wakeStddevMin: number;
}): LifeOpsScheduleRegularity["regularityClass"] {
  if (args.sampleCount < 5) {
    return "insufficient_data";
  }
  const worstStddev = Math.max(args.bedtimeStddevMin, args.wakeStddevMin);
  if (args.sri >= 85 && worstStddev <= 45) {
    return "very_regular";
  }
  if (args.sri >= 70 && worstStddev <= 90) {
    return "regular";
  }
  if (args.sri >= 50) {
    return "irregular";
  }
  return "very_irregular";
}

export function computeSleepRegularity(args: {
  episodes: readonly SleepRegularityEpisodeLike[];
  timezone: string;
  nowMs: number;
  windowDays?: number;
}): LifeOpsScheduleRegularity {
  const windowDays = args.windowDays ?? 28;
  const relevant = args.episodes.filter((episode) =>
    isRegularityEpisode(episode, args.nowMs),
  );

  if (relevant.length === 0) {
    return {
      sri: 0,
      bedtimeStddevMin: 0,
      wakeStddevMin: 0,
      midSleepStddevMin: 0,
      regularityClass: "insufficient_data",
      sampleCount: 0,
      windowDays,
    };
  }

  const bedtimeMinutes = relevant.map((episode) =>
    localMinuteOfDay(Date.parse(episode.startAt), args.timezone),
  );
  const wakeMinutes = relevant.map((episode) =>
    localMinuteOfDay(Date.parse(episode.endAt), args.timezone),
  );
  const midSleepMinutes = relevant.map((episode) => {
    const startMs = Date.parse(episode.startAt);
    const endMs = Date.parse(episode.endAt);
    const midpointMs = startMs + Math.round((endMs - startMs) / 2);
    return localMinuteOfDay(midpointMs, args.timezone);
  });
  const sri = computeSleepRegularityIndex({
    episodes: relevant,
    nowMs: args.nowMs,
    windowDays,
  });
  const bedtimeStddevMin = circularStddevMinutes(bedtimeMinutes);
  const wakeStddevMin = circularStddevMinutes(wakeMinutes);
  const midSleepStddevMin = circularStddevMinutes(midSleepMinutes);
  return {
    sri,
    bedtimeStddevMin,
    wakeStddevMin,
    midSleepStddevMin,
    regularityClass: classifyRegularity({
      sampleCount: relevant.length,
      sri,
      bedtimeStddevMin,
      wakeStddevMin,
    }),
    sampleCount: relevant.length,
    windowDays,
  };
}

const BASELINE_MIN_SAMPLE_COUNT = 5;

function circularMeanHour(minuteValues: readonly number[]): number | null {
  if (minuteValues.length === 0) return null;
  const angleScale = (2 * Math.PI) / (24 * 60);
  let sumSin = 0;
  let sumCos = 0;
  for (const minute of minuteValues) {
    const angle = minute * angleScale;
    sumSin += Math.sin(angle);
    sumCos += Math.cos(angle);
  }
  const meanSin = sumSin / minuteValues.length;
  const meanCos = sumCos / minuteValues.length;
  if (meanSin === 0 && meanCos === 0) return null;
  let meanAngle = Math.atan2(meanSin, meanCos);
  if (meanAngle < 0) meanAngle += 2 * Math.PI;
  return round(meanAngle / angleScale / 60);
}

function medianNumber(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    const value = sorted[middle];
    return value === undefined ? null : round(value);
  }
  const lower = sorted[middle - 1];
  const upper = sorted[middle];
  if (lower === undefined || upper === undefined) {
    return null;
  }
  return round((lower + upper) / 2);
}

export function computePersonalBaseline(args: {
  episodes: readonly SleepRegularityEpisodeLike[];
  timezone: string;
  nowMs: number;
  windowDays?: number;
}): LifeOpsPersonalBaseline | null {
  const windowDays = args.windowDays ?? 28;
  const relevant = args.episodes.filter((episode) =>
    isRegularityEpisode(episode, args.nowMs),
  );
  if (relevant.length < BASELINE_MIN_SAMPLE_COUNT) {
    return null;
  }
  const bedtimeMinutes = relevant.map((episode) =>
    localMinuteOfDay(Date.parse(episode.startAt), args.timezone),
  );
  const wakeMinutes = relevant.map((episode) =>
    localMinuteOfDay(Date.parse(episode.endAt), args.timezone),
  );
  const durations = relevant.map((episode) =>
    durationMinutes(Date.parse(episode.startAt), Date.parse(episode.endAt)),
  );
  const bedtimeMean = circularMeanHour(bedtimeMinutes);
  const wakeMean = circularMeanHour(wakeMinutes);
  if (bedtimeMean === null || wakeMean === null) {
    return null;
  }
  const medianBedtimeLocalHour =
    bedtimeMean < 12 ? round(bedtimeMean + 24) : bedtimeMean;
  return {
    medianWakeLocalHour: wakeMean,
    medianBedtimeLocalHour,
    medianSleepDurationMin: medianNumber(durations) ?? 0,
    bedtimeStddevMin: circularStddevMinutes(bedtimeMinutes),
    wakeStddevMin: circularStddevMinutes(wakeMinutes),
    sampleCount: relevant.length,
    windowDays,
  };
}
