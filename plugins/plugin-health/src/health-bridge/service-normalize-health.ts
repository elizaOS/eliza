import type { LifeOpsHealthSignal } from "../contracts/health.js";
import { LIFEOPS_HEALTH_SIGNAL_SOURCES } from "../contracts/health.js";
import {
  fail,
  normalizeOptionalBoolean,
  normalizeOptionalFiniteNumber,
  normalizeOptionalIsoString,
  normalizeOptionalString,
  requireNonEmptyString,
} from "../util/normalize.js";

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(400, `${field} must be an object`);
  }
  return { ...value } as Record<string, unknown>;
}

function normalizeOptionalRecord(
  value: unknown,
  field: string,
): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  return requireRecord(value, field);
}

export function normalizeHealthSignal(
  value: unknown,
  field: string,
): LifeOpsHealthSignal | null {
  if (value === null || value === undefined) {
    return null;
  }
  const record = requireRecord(value, field);
  const sleep = normalizeOptionalRecord(record.sleep, `${field}.sleep`) ?? {};
  const biometrics =
    normalizeOptionalRecord(record.biometrics, `${field}.biometrics`) ?? {};
  const permissions =
    normalizeOptionalRecord(record.permissions, `${field}.permissions`) ?? {};
  const source = normalizeOptionalString(record.source) ?? "healthkit";
  if (!(LIFEOPS_HEALTH_SIGNAL_SOURCES as readonly string[]).includes(source)) {
    fail(
      400,
      `${field}.source must be one of: ${LIFEOPS_HEALTH_SIGNAL_SOURCES.join(", ")}`,
    );
  }
  const warnings = Array.isArray(record.warnings)
    ? record.warnings.map((warning, index) =>
        requireNonEmptyString(warning, `${field}.warnings[${index}]`),
      )
    : [];
  return {
    source: source as LifeOpsHealthSignal["source"],
    permissions: {
      sleep:
        normalizeOptionalBoolean(
          permissions.sleep,
          `${field}.permissions.sleep`,
        ) ?? false,
      biometrics:
        normalizeOptionalBoolean(
          permissions.biometrics,
          `${field}.permissions.biometrics`,
        ) ?? false,
    },
    sleep: {
      available:
        normalizeOptionalBoolean(sleep.available, `${field}.sleep.available`) ??
        false,
      isSleeping:
        normalizeOptionalBoolean(
          sleep.isSleeping,
          `${field}.sleep.isSleeping`,
        ) ?? false,
      asleepAt:
        normalizeOptionalIsoString(sleep.asleepAt, `${field}.sleep.asleepAt`) ??
        null,
      awakeAt:
        normalizeOptionalIsoString(sleep.awakeAt, `${field}.sleep.awakeAt`) ??
        null,
      durationMinutes: normalizeOptionalFiniteNumber(
        sleep.durationMinutes,
        `${field}.sleep.durationMinutes`,
      ),
      stage: normalizeOptionalString(sleep.stage) ?? null,
    },
    biometrics: {
      sampleAt:
        normalizeOptionalIsoString(
          biometrics.sampleAt,
          `${field}.biometrics.sampleAt`,
        ) ?? null,
      heartRateBpm: normalizeOptionalFiniteNumber(
        biometrics.heartRateBpm,
        `${field}.biometrics.heartRateBpm`,
      ),
      restingHeartRateBpm: normalizeOptionalFiniteNumber(
        biometrics.restingHeartRateBpm,
        `${field}.biometrics.restingHeartRateBpm`,
      ),
      heartRateVariabilityMs: normalizeOptionalFiniteNumber(
        biometrics.heartRateVariabilityMs,
        `${field}.biometrics.heartRateVariabilityMs`,
      ),
      respiratoryRate: normalizeOptionalFiniteNumber(
        biometrics.respiratoryRate,
        `${field}.biometrics.respiratoryRate`,
      ),
      bloodOxygenPercent: normalizeOptionalFiniteNumber(
        biometrics.bloodOxygenPercent,
        `${field}.biometrics.bloodOxygenPercent`,
      ),
    },
    warnings,
  };
}
