import type {
  DisconnectLifeOpsHealthConnectorRequest,
  GetLifeOpsHealthSummaryRequest,
  LifeOpsConnectorMode,
  LifeOpsConnectorSide,
  LifeOpsHealthConnectorCapability,
  LifeOpsHealthConnectorProvider,
  LifeOpsHealthConnectorStatus,
  LifeOpsHealthDailySummary,
  LifeOpsHealthMetric,
  LifeOpsHealthMetricSample,
  LifeOpsHealthSummaryResponse,
  StartLifeOpsHealthConnectorRequest,
  StartLifeOpsHealthConnectorResponse,
  SyncLifeOpsHealthConnectorRequest,
} from "../contracts/index.js";
import {
  LIFEOPS_HEALTH_CONNECTOR_CAPABILITIES,
  LIFEOPS_HEALTH_CONNECTOR_PROVIDERS,
} from "../contracts/index.js";
import {
  detectHealthBackend,
  getDailySummary,
  getDataPoints,
  getRecentSummaries,
  type HealthBackend,
  type HealthBridgeConfig,
  HealthBridgeError,
  type HealthDailySummary,
  type HealthDataPoint,
  HealthConnectorApiError,
  syncHealthConnectorData,
  completeHealthConnectorOAuth,
  deleteStoredHealthToken,
  HealthOAuthError,
  healthConnectorCapabilities,
  readStoredHealthToken,
  refreshStoredHealthToken,
  resolveHealthOAuthConfig,
  startHealthConnectorOAuth,
} from "@elizaos/plugin-health";
import {
  createLifeOpsConnectorGrant,
  createLifeOpsHealthSyncState,
} from "./repository.js";
import type {
  Constructor,
  LifeOpsServiceBase,
  MixinClass,
} from "./service-mixin-core.js";
import {
  fail,
  normalizeEnumValue,
  normalizeOptionalString,
} from "./service-normalize.js";
import {
  normalizeOptionalConnectorMode,
  normalizeOptionalConnectorSide,
} from "./service-normalize-connector.js";
import { LifeOpsServiceError } from "./service-types.js";

type HealthSyncRequest = SyncLifeOpsHealthConnectorRequest & {
  failOnProviderError?: boolean;
};

type DailySummaryAverageField =
  | "heartRateAvg"
  | "restingHeartRate"
  | "hrvMs"
  | "sleepScore"
  | "readinessScore"
  | "weightKg"
  | "bloodPressureSystolic"
  | "bloodPressureDiastolic"
  | "bloodOxygenPercent";

type LifeOpsHealthServicePublic = {
  getHealthConnectorStatus(): Promise<{
    available: boolean;
    backend: HealthBackend;
    lastCheckedAt: string;
  }>;
  getHealthDataConnectorStatuses(
    requestUrl: URL,
    requestedMode?: LifeOpsConnectorMode,
    requestedSide?: LifeOpsConnectorSide,
  ): Promise<LifeOpsHealthConnectorStatus[]>;
  getHealthDataConnectorStatus(
    provider: LifeOpsHealthConnectorProvider,
    requestUrl: URL,
    requestedMode?: LifeOpsConnectorMode,
    requestedSide?: LifeOpsConnectorSide,
  ): Promise<LifeOpsHealthConnectorStatus>;
  startHealthConnector(
    request: StartLifeOpsHealthConnectorRequest,
    requestUrl: URL,
  ): Promise<StartLifeOpsHealthConnectorResponse>;
  completeHealthConnectorCallback(
    callbackUrl: URL,
  ): Promise<LifeOpsHealthConnectorStatus>;
  disconnectHealthConnector(
    request: DisconnectLifeOpsHealthConnectorRequest,
    requestUrl: URL,
  ): Promise<LifeOpsHealthConnectorStatus>;
  syncHealthConnectors(
    request?: SyncLifeOpsHealthConnectorRequest,
  ): Promise<LifeOpsHealthSummaryResponse>;
  getHealthSummary(
    request?: GetLifeOpsHealthSummaryRequest,
  ): Promise<LifeOpsHealthSummaryResponse>;
  getHealthDailySummary(date: string): Promise<HealthDailySummary>;
  getHealthTrend(days: number): Promise<HealthDailySummary[]>;
  getHealthDataPoints(opts: {
    metric: HealthDataPoint["metric"];
    startAt: string;
    endAt: string;
  }): Promise<HealthDataPoint[]>;
};

const DEFAULT_HEALTH_SUMMARY_DAYS = 7;
const MAX_HEALTH_SUMMARY_DAYS = 31;

function resolveHealthConfig(): HealthBridgeConfig {
  return {
    healthKitCliPath: process.env.ELIZA_HEALTHKIT_CLI_PATH,
    googleFitAccessToken: process.env.ELIZA_GOOGLE_FIT_ACCESS_TOKEN,
  };
}

function translateHealthError(error: unknown): never {
  if (error instanceof HealthBridgeError) {
    const status = error.backend === "none" ? 503 : 502;
    throw new LifeOpsServiceError(status, error.message);
  }
  throw error;
}

function normalizeHealthProvider(
  value: unknown,
  field = "provider",
): LifeOpsHealthConnectorProvider {
  return normalizeEnumValue(value, field, LIFEOPS_HEALTH_CONNECTOR_PROVIDERS);
}

function normalizeOptionalHealthProvider(
  value: unknown,
): LifeOpsHealthConnectorProvider | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  return normalizeHealthProvider(value);
}

function normalizeHealthCapabilities(
  value: unknown,
): LifeOpsHealthConnectorCapability[] | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    fail(400, "capabilities must be an array");
  }
  const capabilities: LifeOpsHealthConnectorCapability[] = [];
  const seen = new Set<LifeOpsHealthConnectorCapability>();
  for (const candidate of value) {
    const capability = normalizeEnumValue(
      candidate,
      "capabilities[]",
      LIFEOPS_HEALTH_CONNECTOR_CAPABILITIES,
    );
    if (!seen.has(capability)) {
      seen.add(capability);
      capabilities.push(capability);
    }
  }
  return capabilities;
}

function normalizeDateOnly(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value.trim())) {
    fail(400, `${field} must be a YYYY-MM-DD date`);
  }
  const normalized = value.trim();
  const parsed = Date.parse(`${normalized}T00:00:00.000Z`);
  if (!Number.isFinite(parsed)) {
    fail(400, `${field} must be a valid date`);
  }
  return normalized;
}

function normalizeDays(value: unknown): number {
  if (value === undefined || value === null || value === "") {
    return DEFAULT_HEALTH_SUMMARY_DAYS;
  }
  const parsed = typeof value === "number" ? value : Number(String(value));
  if (!Number.isFinite(parsed) || parsed <= 0) {
    fail(400, "days must be a positive integer");
  }
  return Math.min(Math.trunc(parsed), MAX_HEALTH_SUMMARY_DAYS);
}

function dateOnlyFromMs(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function resolveHealthWindow(request: {
  startDate?: string | null;
  endDate?: string | null;
  days?: number;
}): { startDate: string; endDate: string; days: number } {
  const days = normalizeDays(request.days);
  const endDate =
    normalizeDateOnly(request.endDate, "endDate") ?? dateOnlyFromMs(Date.now());
  const startDate =
    normalizeDateOnly(request.startDate, "startDate") ??
    dateOnlyFromMs(
      Date.parse(`${endDate}T00:00:00.000Z`) - (days - 1) * 86_400_000,
    );
  if (startDate > endDate) {
    fail(400, "startDate must be on or before endDate");
  }
  return { startDate, endDate, days };
}

function normalizeHealthMetrics(
  metrics: readonly LifeOpsHealthMetric[] | undefined,
): LifeOpsHealthMetric[] | undefined {
  if (!metrics || metrics.length === 0) {
    return undefined;
  }
  return [...new Set(metrics)];
}

function healthCapabilitiesFromGrant(
  capabilities: readonly string[],
): LifeOpsHealthConnectorCapability[] {
  return capabilities.filter(
    (capability): capability is LifeOpsHealthConnectorCapability =>
      (LIFEOPS_HEALTH_CONNECTOR_CAPABILITIES as readonly string[]).includes(
        capability,
      ),
  );
}

function emptyDailySummary(
  provider: LifeOpsHealthConnectorProvider,
  date: string,
): LifeOpsHealthDailySummary {
  return {
    date,
    provider,
    steps: 0,
    activeMinutes: 0,
    sleepHours: 0,
    calories: null,
    distanceMeters: null,
    heartRateAvg: null,
    restingHeartRate: null,
    hrvMs: null,
    sleepScore: null,
    readinessScore: null,
    weightKg: null,
    bloodPressureSystolic: null,
    bloodPressureDiastolic: null,
    bloodOxygenPercent: null,
  };
}

function summarizeSamples(
  samples: readonly LifeOpsHealthMetricSample[],
): LifeOpsHealthDailySummary[] {
  const summaries = new Map<string, LifeOpsHealthDailySummary>();
  const averages = new Map<string, { total: number; count: number }>();
  const keyFor = (sample: LifeOpsHealthMetricSample) =>
    `${sample.provider}:${sample.localDate}`;
  const summaryFor = (sample: LifeOpsHealthMetricSample) => {
    const key = keyFor(sample);
    const current = summaries.get(key);
    if (current) {
      return current;
    }
    const next = emptyDailySummary(sample.provider, sample.localDate);
    summaries.set(key, next);
    return next;
  };
  const addNullable = (
    summary: LifeOpsHealthDailySummary,
    field: "calories" | "distanceMeters",
    value: number,
  ) => {
    summary[field] = (summary[field] ?? 0) + value;
  };
  const addAverage = (
    sample: LifeOpsHealthMetricSample,
    output: DailySummaryAverageField,
  ) => {
    const bucketKey = `${keyFor(sample)}:${output}`;
    const bucket = averages.get(bucketKey) ?? { total: 0, count: 0 };
    bucket.total += sample.value;
    bucket.count += 1;
    averages.set(bucketKey, bucket);
  };
  for (const sample of samples) {
    const summary = summaryFor(sample);
    switch (sample.metric) {
      case "steps":
        summary.steps += sample.value;
        break;
      case "active_minutes":
        summary.activeMinutes += sample.value;
        break;
      case "sleep_hours":
        summary.sleepHours += sample.value;
        break;
      case "calories":
        addNullable(summary, "calories", sample.value);
        break;
      case "distance_meters":
        addNullable(summary, "distanceMeters", sample.value);
        break;
      case "heart_rate":
        addAverage(sample, "heartRateAvg");
        break;
      case "resting_heart_rate":
        addAverage(sample, "restingHeartRate");
        break;
      case "heart_rate_variability":
        addAverage(sample, "hrvMs");
        break;
      case "sleep_score":
        addAverage(sample, "sleepScore");
        break;
      case "readiness_score":
        addAverage(sample, "readinessScore");
        break;
      case "weight_kg":
        addAverage(sample, "weightKg");
        break;
      case "blood_pressure_systolic":
        addAverage(sample, "bloodPressureSystolic");
        break;
      case "blood_pressure_diastolic":
        addAverage(sample, "bloodPressureDiastolic");
        break;
      case "blood_oxygen_percent":
        addAverage(sample, "bloodOxygenPercent");
        break;
      case "respiratory_rate":
      case "body_temperature_celsius":
        break;
    }
  }
  for (const [bucketKey, bucket] of averages) {
    const [provider, date, field] = bucketKey.split(":") as [
      LifeOpsHealthConnectorProvider,
      string,
      DailySummaryAverageField,
    ];
    const summary = summaries.get(`${provider}:${date}`);
    if (summary && bucket.count > 0) {
      summary[field] = bucket.total / bucket.count;
    }
  }
  return [...summaries.values()].sort((left, right) =>
    left.date === right.date
      ? left.provider.localeCompare(right.provider)
      : right.date.localeCompare(left.date),
  );
}

function healthReasonForAuthError(error: unknown): boolean {
  return (
    error instanceof HealthOAuthError ||
    (error instanceof HealthConnectorApiError &&
      (error.status === 401 || error.status === 403))
  );
}

/** @internal */
export function withHealth<TBase extends Constructor<LifeOpsServiceBase>>(
  Base: TBase,
): MixinClass<TBase, LifeOpsHealthServicePublic> {
  class LifeOpsHealthServiceMixin extends Base {
    async getHealthConnectorStatus(): Promise<{
      available: boolean;
      backend: HealthBackend;
      lastCheckedAt: string;
    }> {
      const config = resolveHealthConfig();
      const backend = await detectHealthBackend(config);
      return {
        available: backend !== "none",
        backend,
        lastCheckedAt: new Date().toISOString(),
      };
    }

    async getHealthDataConnectorStatuses(
      requestUrl: URL,
      requestedMode?: LifeOpsConnectorMode,
      requestedSide?: LifeOpsConnectorSide,
    ): Promise<LifeOpsHealthConnectorStatus[]> {
      return Promise.all(
        LIFEOPS_HEALTH_CONNECTOR_PROVIDERS.map((provider) =>
          this.getHealthDataConnectorStatus(
            provider,
            requestUrl,
            requestedMode,
            requestedSide,
          ),
        ),
      );
    }

    async getHealthDataConnectorStatus(
      providerInput: LifeOpsHealthConnectorProvider,
      requestUrl: URL,
      requestedMode?: LifeOpsConnectorMode,
      requestedSide?: LifeOpsConnectorSide,
    ): Promise<LifeOpsHealthConnectorStatus> {
      const provider = normalizeHealthProvider(providerInput);
      const side =
        normalizeOptionalConnectorSide(requestedSide, "side") ?? "owner";
      const explicitMode = normalizeOptionalConnectorMode(
        requestedMode,
        "mode",
      );
      const grants = (
        await this.repository.listConnectorGrants(this.agentId())
      ).filter(
        (grant) =>
          grant.provider === provider &&
          grant.side === side &&
          (!explicitMode || grant.mode === explicitMode),
      );
      const preferredGrant =
        [...grants].sort((left, right) =>
          right.updatedAt.localeCompare(left.updatedAt),
        )[0] ?? null;
      const config = resolveHealthOAuthConfig(
        provider,
        requestUrl,
        explicitMode ?? preferredGrant?.mode,
      );
      const grant =
        preferredGrant ??
        (await this.repository.getConnectorGrant(
          this.agentId(),
          provider,
          config.mode,
          side,
        ));
      const token = readStoredHealthToken(grant?.tokenRef);
      const syncState = grant
        ? await this.repository.getHealthSyncState(
            this.agentId(),
            provider,
            grant.id,
          )
        : null;
      const metadataAuthState =
        typeof grant?.metadata.authState === "string"
          ? grant.metadata.authState
          : null;
      const connected = Boolean(
        grant && token && metadataAuthState !== "needs_reauth",
      );
      const reason: LifeOpsHealthConnectorStatus["reason"] = connected
        ? syncState?.lastSyncError
          ? "sync_failed"
          : "connected"
        : grant && (grant.tokenRef || metadataAuthState === "needs_reauth")
          ? "needs_reauth"
          : config.configured
            ? "disconnected"
            : "config_missing";
      return {
        provider,
        side,
        mode: grant?.mode ?? config.mode,
        defaultMode: config.defaultMode,
        availableModes: config.availableModes,
        executionTarget: grant?.executionTarget ?? "local",
        sourceOfTruth: grant?.sourceOfTruth ?? "local_storage",
        configured: config.configured,
        connected,
        reason,
        identity: token?.identity ?? grant?.identity ?? null,
        grantedCapabilities: grant
          ? healthCapabilitiesFromGrant(grant.capabilities)
          : healthConnectorCapabilities(provider),
        grantedScopes: token?.grantedScopes ?? grant?.grantedScopes ?? [],
        expiresAt: token?.expiresAt
          ? new Date(token.expiresAt).toISOString()
          : typeof grant?.metadata.expiresAt === "string"
            ? grant.metadata.expiresAt
            : null,
        hasRefreshToken:
          Boolean(token?.refreshToken) ||
          Boolean(grant?.metadata.hasRefreshToken),
        lastSyncAt: syncState?.lastSyncedAt ?? null,
        grant,
        degradations: syncState?.lastSyncError
          ? [
              {
                axis: "delivery-degraded",
                code: "last_sync_failed",
                message: syncState.lastSyncError,
                retryable: true,
              },
            ]
          : undefined,
      };
    }

    async startHealthConnector(
      request: StartLifeOpsHealthConnectorRequest,
      requestUrl: URL,
    ): Promise<StartLifeOpsHealthConnectorResponse> {
      const provider = normalizeHealthProvider(request.provider);
      const mode = normalizeOptionalConnectorMode(request.mode, "mode");
      if (mode === "cloud_managed") {
        fail(
          501,
          "Cloud-managed health OAuth is not wired for this provider yet.",
        );
      }
      const side =
        normalizeOptionalConnectorSide(request.side, "side") ?? "owner";
      const capabilities = normalizeHealthCapabilities(request.capabilities);
      try {
        return startHealthConnectorOAuth({
          provider,
          agentId: this.agentId(),
          side,
          mode,
          requestUrl,
          redirectUrl: normalizeOptionalString(request.redirectUrl),
          capabilities,
        });
      } catch (error) {
        if (error instanceof HealthOAuthError) {
          fail(error.status, error.message);
        }
        this.logLifeOpsError("health_connector_start", error, { provider });
        throw error;
      }
    }

    async completeHealthConnectorCallback(
      callbackUrl: URL,
    ): Promise<LifeOpsHealthConnectorStatus> {
      try {
        const result = await completeHealthConnectorOAuth(callbackUrl);
        if (result.agentId !== this.agentId()) {
          fail(
            409,
            "Health connector callback does not belong to the active agent.",
          );
        }
        const existingGrant = await this.repository.getConnectorGrant(
          this.agentId(),
          result.provider,
          result.mode,
          result.side,
        );
        const nowIso = new Date().toISOString();
        const grant = existingGrant
          ? {
              ...existingGrant,
              identity: { ...result.identity },
              grantedScopes: [...result.grantedScopes],
              capabilities: [...result.grantedCapabilities],
              tokenRef: result.tokenRef,
              executionTarget: "local" as const,
              sourceOfTruth: "local_storage" as const,
              cloudConnectionId: null,
              metadata: {
                ...existingGrant.metadata,
                authState: "connected",
                expiresAt: result.expiresAt,
                hasRefreshToken: result.hasRefreshToken,
              },
              lastRefreshAt: nowIso,
              updatedAt: nowIso,
            }
          : createLifeOpsConnectorGrant({
              agentId: this.agentId(),
              provider: result.provider,
              side: result.side,
              identity: { ...result.identity },
              grantedScopes: [...result.grantedScopes],
              capabilities: [...result.grantedCapabilities],
              tokenRef: result.tokenRef,
              mode: result.mode,
              executionTarget: "local",
              sourceOfTruth: "local_storage",
              metadata: {
                authState: "connected",
                expiresAt: result.expiresAt,
                hasRefreshToken: result.hasRefreshToken,
              },
              lastRefreshAt: nowIso,
            });
        await this.repository.upsertConnectorGrant(grant);
        await this.recordConnectorAudit(
          `${result.provider}:${result.mode}`,
          "health connector granted",
          {
            provider: result.provider,
            side: result.side,
            mode: result.mode,
            capabilities: result.grantedCapabilities,
          },
          {
            tokenRef: result.tokenRef,
            expiresAt: result.expiresAt,
          },
        );
        return this.getHealthDataConnectorStatus(
          result.provider,
          callbackUrl,
          result.mode,
          result.side,
        );
      } catch (error) {
        if (error instanceof HealthOAuthError) {
          fail(error.status, error.message);
        }
        throw error;
      }
    }

    async disconnectHealthConnector(
      request: DisconnectLifeOpsHealthConnectorRequest,
      requestUrl: URL,
    ): Promise<LifeOpsHealthConnectorStatus> {
      const provider = normalizeHealthProvider(request.provider);
      const mode = normalizeOptionalConnectorMode(request.mode, "mode");
      const side =
        normalizeOptionalConnectorSide(request.side, "side") ?? "owner";
      const grantId = normalizeOptionalString(request.grantId);
      const grants = (
        await this.repository.listConnectorGrants(this.agentId())
      ).filter(
        (grant) =>
          grant.provider === provider &&
          grant.side === side &&
          (!mode || grant.mode === mode),
      );
      const grant = grantId
        ? (grants.find((candidate) => candidate.id === grantId) ?? null)
        : ([...grants].sort((left, right) =>
            right.updatedAt.localeCompare(left.updatedAt),
          )[0] ?? null);
      if (grant?.tokenRef) {
        deleteStoredHealthToken(grant.tokenRef);
      }
      if (grant) {
        await this.repository.deleteConnectorGrant(
          this.agentId(),
          provider,
          grant.mode,
          grant.side,
          grant.id,
        );
      }
      return this.getHealthDataConnectorStatus(
        provider,
        requestUrl,
        mode ?? grant?.mode,
        side,
      );
    }

    async syncHealthConnectors(
      request: HealthSyncRequest = {},
    ): Promise<LifeOpsHealthSummaryResponse> {
      const provider = normalizeOptionalHealthProvider(request.provider);
      const side =
        normalizeOptionalConnectorSide(request.side, "side") ?? "owner";
      const mode = normalizeOptionalConnectorMode(request.mode, "mode");
      const { startDate, endDate } = resolveHealthWindow(request);
      const requestUrl = new URL("http://127.0.0.1/");
      const statuses = provider
        ? [
            await this.getHealthDataConnectorStatus(
              provider,
              requestUrl,
              mode,
              side,
            ),
          ]
        : await this.getHealthDataConnectorStatuses(requestUrl, mode, side);
      for (const status of statuses) {
        const grant = status.grant;
        if (!status.connected || !grant?.tokenRef) {
          continue;
        }
        try {
          const token = await refreshStoredHealthToken(grant.tokenRef);
          if (!token) {
            fail(
              401,
              `${status.provider} health connector needs re-authentication.`,
            );
          }
          const payload = await syncHealthConnectorData({
            token,
            grantId: grant.id,
            startDate,
            endDate,
          });
          for (const sample of payload.samples) {
            await this.repository.upsertHealthMetricSample(sample);
          }
          for (const workout of payload.workouts) {
            await this.repository.upsertHealthWorkout(workout);
          }
          for (const episode of payload.sleepEpisodes) {
            await this.repository.upsertHealthSleepEpisode(episode);
          }
          const syncedAt = new Date().toISOString();
          await this.repository.upsertHealthSyncState(
            createLifeOpsHealthSyncState({
              agentId: this.agentId(),
              provider: status.provider,
              grantId: grant.id,
              cursor: payload.cursor,
              lastSyncedAt: syncedAt,
              lastSyncStartedAt: syncedAt,
              lastSyncError: null,
              metadata: {
                sampleCount: payload.samples.length,
                workoutCount: payload.workouts.length,
                sleepEpisodeCount: payload.sleepEpisodes.length,
              },
            }),
          );
          await this.repository.upsertConnectorGrant({
            ...grant,
            identity: payload.identity ?? grant.identity,
            metadata: {
              ...grant.metadata,
              authState: "connected",
              lastSyncAt: syncedAt,
            },
            lastRefreshAt: syncedAt,
            updatedAt: syncedAt,
          });
        } catch (error) {
          const failedAt = new Date().toISOString();
          await this.repository.upsertHealthSyncState(
            createLifeOpsHealthSyncState({
              agentId: this.agentId(),
              provider: status.provider,
              grantId: grant.id,
              cursor: null,
              lastSyncedAt: status.lastSyncAt,
              lastSyncStartedAt: failedAt,
              lastSyncError:
                error instanceof Error ? error.message : String(error),
              metadata: {},
            }),
          );
          if (healthReasonForAuthError(error)) {
            await this.repository.upsertConnectorGrant({
              ...grant,
              metadata: {
                ...grant.metadata,
                authState: "needs_reauth",
                lastAuthError:
                  error instanceof Error ? error.message : String(error),
                lastAuthErrorAt: failedAt,
              },
              updatedAt: failedAt,
            });
          }
          this.logLifeOpsWarn(
            "health_connector_sync",
            error instanceof Error ? error.message : String(error),
            { provider: status.provider },
          );
          if (provider || request.failOnProviderError) {
            if (error instanceof HealthConnectorApiError) {
              fail(error.status || 502, error.message);
            }
            if (error instanceof HealthOAuthError) {
              fail(error.status, error.message);
            }
            throw error;
          }
        }
      }
      return this.getHealthSummary({
        provider,
        side,
        mode,
        startDate,
        endDate,
        forceSync: false,
      });
    }

    async getHealthSummary(
      request: GetLifeOpsHealthSummaryRequest = {},
    ): Promise<LifeOpsHealthSummaryResponse> {
      const provider = normalizeOptionalHealthProvider(request.provider);
      const side =
        normalizeOptionalConnectorSide(request.side, "side") ?? "owner";
      const mode = normalizeOptionalConnectorMode(request.mode, "mode");
      const { startDate, endDate } = resolveHealthWindow(request);
      if (request.forceSync) {
        return this.syncHealthConnectors({
          provider,
          side,
          mode,
          startDate,
          endDate,
          days: request.days,
        });
      }
      const requestUrl = new URL("http://127.0.0.1/");
      const providers = provider
        ? [
            await this.getHealthDataConnectorStatus(
              provider,
              requestUrl,
              mode,
              side,
            ),
          ]
        : await this.getHealthDataConnectorStatuses(requestUrl, mode, side);
      const samples = await this.repository.listHealthMetricSamples(
        this.agentId(),
        {
          provider,
          startDate,
          endDate,
          metrics: normalizeHealthMetrics(request.metrics),
          limit: 2_000,
        },
      );
      const [workouts, sleepEpisodes] = await Promise.all([
        this.repository.listHealthWorkouts(this.agentId(), {
          provider,
          startDate,
          endDate,
          limit: 500,
        }),
        this.repository.listHealthSleepEpisodes(this.agentId(), {
          provider,
          startDate,
          endDate,
          limit: 500,
        }),
      ]);
      return {
        providers,
        summaries: summarizeSamples(samples),
        samples,
        workouts,
        sleepEpisodes,
        syncedAt: new Date().toISOString(),
      };
    }

    async getHealthDailySummary(date: string): Promise<HealthDailySummary> {
      try {
        return await getDailySummary(date, resolveHealthConfig());
      } catch (error) {
        translateHealthError(error);
      }
    }

    async getHealthTrend(days: number): Promise<HealthDailySummary[]> {
      try {
        return await getRecentSummaries(days, resolveHealthConfig());
      } catch (error) {
        translateHealthError(error);
      }
    }

    async getHealthDataPoints(opts: {
      metric: HealthDataPoint["metric"];
      startAt: string;
      endAt: string;
    }): Promise<HealthDataPoint[]> {
      try {
        return await getDataPoints(opts, resolveHealthConfig());
      } catch (error) {
        translateHealthError(error);
      }
    }
  }

  return LifeOpsHealthServiceMixin as unknown as MixinClass<
    TBase,
    LifeOpsHealthServicePublic
  >;
}
