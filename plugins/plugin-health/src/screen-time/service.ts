/**
 * Owns screen-time aggregation orchestration over injected activity and social
 * ports so hosts provide storage without reimplementing Health calculations.
 */
import type {
  LifeOpsScreenTimeBreakdown,
  LifeOpsScreenTimeHistoryPoint,
  LifeOpsScreenTimeHistoryResponse,
  LifeOpsScreenTimeRangeKey,
  LifeOpsScreenTimeSource,
  LifeOpsScreenTimeSummary,
  LifeOpsSocialHabitSummary,
} from "../contracts/lifeops.js";
import {
  buildScreenTimeBreakdown,
  buildScreenTimeMetrics,
  buildScreenTimeSummary,
  buildScreenTimeVisibleBuckets,
  buildScreenTimeWeeklyAverageItems,
  type ScreenTimeAggregateRow,
  type ScreenTimeWeeklyAverageItem,
} from "./builders.js";
import {
  computePriorScreenTimeRange,
  computeScreenTimeRange,
  enumerateScreenTimeHistoryDays,
  screenTimeRangeLabel,
} from "./ranges.js";

export interface ScreenTimeQuery {
  since: string;
  until: string;
  source?: LifeOpsScreenTimeSource;
  identifier?: string;
  topN?: number;
}

export interface ScreenTimeServicePorts {
  collectRows(
    query: Omit<ScreenTimeQuery, "topN">,
  ): Promise<ScreenTimeAggregateRow[]>;
  getSocialSummary(query: {
    since: string;
    until: string;
    topN?: number;
  }): Promise<LifeOpsSocialHabitSummary>;
  now?: () => Date;
}

export interface ScreenTimeAggregationService {
  getScreenTimeSummary(
    query: ScreenTimeQuery,
  ): Promise<LifeOpsScreenTimeSummary>;
  getScreenTimeBreakdown(
    query: ScreenTimeQuery,
  ): Promise<LifeOpsScreenTimeBreakdown>;
  getScreenTimeHistory(query: {
    range: LifeOpsScreenTimeRangeKey;
    topN?: number;
    socialTopN?: number;
  }): Promise<LifeOpsScreenTimeHistoryResponse>;
  getScreenTimeWeeklyAverageByApp(query: {
    since: string;
    until: string;
    daysInWindow: number;
    identifier?: string;
    topN?: number;
  }): Promise<{
    items: ScreenTimeWeeklyAverageItem[];
    totalSeconds: number;
    daysInWindow: number;
  }>;
}

export function createScreenTimeAggregationService(
  ports: ScreenTimeServicePorts,
): ScreenTimeAggregationService {
  const getSummary = async (query: ScreenTimeQuery) => {
    const rows = await ports.collectRows(query);
    return buildScreenTimeSummary(rows, query.topN);
  };
  const getBreakdown = async (query: ScreenTimeQuery) => {
    const rows = await ports.collectRows(query);
    return buildScreenTimeBreakdown(rows, query.topN);
  };

  return {
    getScreenTimeSummary: getSummary,
    getScreenTimeBreakdown: getBreakdown,
    async getScreenTimeHistory(query) {
      const now = ports.now?.() ?? new Date();
      const window = computeScreenTimeRange(query.range, now);
      const priorWindow = computePriorScreenTimeRange(query.range, window);
      const [breakdown, social, priorBreakdown, priorSocial] =
        await Promise.all([
          getBreakdown({ ...window, topN: query.topN }),
          ports.getSocialSummary({ ...window, topN: query.socialTopN }),
          priorWindow
            ? getBreakdown({ ...priorWindow, topN: query.topN })
            : Promise.resolve(null),
          priorWindow
            ? ports.getSocialSummary({ ...priorWindow, topN: query.socialTopN })
            : Promise.resolve(null),
        ]);
      const history: LifeOpsScreenTimeHistoryPoint[] =
        query.range === "today"
          ? []
          : await Promise.all(
              enumerateScreenTimeHistoryDays(window).map(async (day) => ({
                ...day,
                totalSeconds: (await getSummary(day)).totalSeconds,
              })),
            );
      return {
        range: query.range,
        label: screenTimeRangeLabel(query.range),
        window,
        priorWindow,
        breakdown,
        social,
        history,
        metrics: buildScreenTimeMetrics(
          breakdown,
          social,
          priorBreakdown,
          priorSocial,
        ),
        visible: buildScreenTimeVisibleBuckets(breakdown, social),
        fetchedAt: now.toISOString(),
      };
    },
    async getScreenTimeWeeklyAverageByApp(query) {
      const summary = await getSummary({
        since: query.since,
        until: query.until,
        source: "app",
        identifier: query.identifier,
        topN: query.topN,
      });
      const daysInWindow = Math.max(1, Math.floor(query.daysInWindow));
      return {
        items: buildScreenTimeWeeklyAverageItems(summary.items, daysInWindow),
        totalSeconds: summary.totalSeconds,
        daysInWindow,
      };
    },
  };
}
