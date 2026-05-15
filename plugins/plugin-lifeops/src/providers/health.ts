import type {
  IAgentRuntime,
  Memory,
  Provider,
  ProviderResult,
  State,
} from "@elizaos/core";
import { hasLifeOpsAccess } from "../lifeops/access.js";
import { LifeOpsService } from "../lifeops/service.js";

const HEALTH_DAILY_LIMIT = 4;

function formatHealthNumber(value: number | null): string | null {
  if (value === null || !Number.isFinite(value)) {
    return null;
  }
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

export const healthProvider: Provider = {
  name: "lifeops-health",
  description:
    "Owner only. Compact LifeOps health connector state and recent wearable metrics. Route detailed health questions to HEALTH.",
  descriptionCompressed: "LifeOps health connector state. Owner only.",
  dynamic: true,
  position: 14,
  contexts: ["health"],
  contextGate: { anyOf: ["health"] },
  cacheScope: "turn",
  roleGate: { minRole: "OWNER" },
  async get(
    runtime: IAgentRuntime,
    message: Memory,
    _state: State,
  ): Promise<ProviderResult> {
    if (!(await hasLifeOpsAccess(runtime, message))) {
      return { text: "", values: {}, data: {} };
    }
    try {
      const service = new LifeOpsService(runtime);
      const summary = await service.getHealthSummary({ days: 3 });
      const connectedProviders = summary.providers
        .filter((provider) => provider.connected)
        .map((provider) => provider.provider)
        .slice(0, 8);
      const lines: string[] = [
        connectedProviders.length > 0
          ? `Health connectors: ${connectedProviders.join(", ")}`
          : "Health connectors: none connected",
        "Use HEALTH for wearable metrics, workouts, readiness, sleep, weight, blood pressure, and vitals.",
      ];
      for (const daily of summary.summaries.slice(0, HEALTH_DAILY_LIMIT)) {
        const parts = [
          `${daily.provider} ${daily.date}`,
          daily.steps > 0 ? `${Math.round(daily.steps)} steps` : null,
          daily.activeMinutes > 0
            ? `${Math.round(daily.activeMinutes)} active min`
            : null,
          daily.sleepHours > 0 ? `${daily.sleepHours.toFixed(1)}h sleep` : null,
          daily.heartRateAvg !== null
            ? `${Math.round(daily.heartRateAvg)} bpm`
            : null,
          daily.weightKg !== null
            ? `${formatHealthNumber(daily.weightKg)} kg`
            : null,
        ].filter((part): part is string => part !== null);
        if (parts.length > 1) {
          lines.push(parts.join(" | "));
        }
      }
      return {
        text: lines.join("\n"),
        values: {
          healthConnectedProviderCount: connectedProviders.length,
          healthConnectedProviders: connectedProviders,
          healthSampleCount: summary.samples.length,
          healthWorkoutCount: summary.workouts.length,
          healthSleepEpisodeCount: summary.sleepEpisodes.length,
        },
        data: {
          healthSummary: {
            ...summary,
            providers: summary.providers.slice(0, 8),
            summaries: summary.summaries.slice(0, HEALTH_DAILY_LIMIT),
            workouts: summary.workouts.slice(0, 10),
            sleepEpisodes: summary.sleepEpisodes.slice(0, 10),
            samples: summary.samples.slice(0, 25),
          },
        },
      };
    } catch (error) {
      return {
        text: "Health connector summary unavailable.",
        values: {
          healthConnectedProviderCount: 0,
          healthConnectedProviders: [],
        },
        data: {
          healthSummary: null,
          error: error instanceof Error ? error.message : String(error),
        },
      };
    }
  },
};
