import { type IAgentRuntime, logger } from "@elizaos/core";
import {
  ALL_FEATURE_KEYS,
  FEATURE_DEFAULTS,
  type FeatureFlagChangeListener,
  type FeatureFlagService,
  type FeatureFlagSource,
  type FeatureFlagState,
  type LifeOpsFeatureKey,
  isLifeOpsFeatureKey,
} from "./feature-flags.types.js";
import {
  executeRawSql,
  parseJsonRecord,
  sqlBoolean,
  sqlJson,
  sqlText,
  toBoolean,
  toText,
} from "./sql.js";

/**
 * SQL-backed FeatureFlagService.
 *
 * Reads & writes the `lifeops_features` table owned by `app-lifeops` and
 * migrated via the plugin's `schema` export.
 * Compile-time defaults (`FEATURE_DEFAULTS`) are the authority when no row
 * exists. The runtime never writes a row with `source = 'default'` —
 * absence is the canonical representation of an unmodified default
 * (Commandment 7).
 */

const SELECT_COLUMNS =
  "feature_key, enabled, source, enabled_at, enabled_by, metadata, created_at, updated_at";

const ALLOWED_SOURCES: ReadonlySet<FeatureFlagSource> = new Set([
  "local",
  "cloud",
]);

function rowToState(
  row: Record<string, unknown>,
  fallback: LifeOpsFeatureKey,
): FeatureFlagState {
  const featureKeyText = toText(row.feature_key);
  if (!isLifeOpsFeatureKey(featureKeyText)) {
    throw new Error(
      `[FeatureFlags] unknown feature_key from db: ${featureKeyText}`,
    );
  }
  const featureKey = featureKeyText;
  const def = FEATURE_DEFAULTS[featureKey];
  const sourceText = toText(row.source);
  if (!ALLOWED_SOURCES.has(sourceText as FeatureFlagSource)) {
    throw new Error(`[FeatureFlags] unknown source from db: ${sourceText}`);
  }
  const enabledAtRaw = row.enabled_at;
  let enabledAt: Date | null = null;
  if (enabledAtRaw instanceof Date) {
    enabledAt = enabledAtRaw;
  } else if (typeof enabledAtRaw === "string" && enabledAtRaw.length > 0) {
    const parsed = new Date(enabledAtRaw);
    if (Number.isNaN(parsed.getTime())) {
      throw new Error(
        `[FeatureFlags] invalid enabled_at for ${fallback}: ${enabledAtRaw}`,
      );
    }
    enabledAt = parsed;
  }
  const enabledByText = toText(row.enabled_by);
  return {
    featureKey,
    enabled: toBoolean(row.enabled),
    source: sourceText as FeatureFlagSource,
    enabledAt,
    enabledBy: enabledByText.length > 0 ? enabledByText : null,
    description: def.description,
    costsMoney: def.costsMoney,
    metadata: parseJsonRecord(row.metadata),
  };
}

function defaultState(key: LifeOpsFeatureKey): FeatureFlagState {
  const def = FEATURE_DEFAULTS[key];
  return {
    featureKey: key,
    enabled: def.enabled,
    source: "default",
    enabledAt: null,
    enabledBy: null,
    description: def.description,
    costsMoney: def.costsMoney,
    metadata: {},
  };
}

class PgFeatureFlagService implements FeatureFlagService {
  private readonly runtime: IAgentRuntime;
  private readonly listeners = new Set<FeatureFlagChangeListener>();

  constructor(runtime: IAgentRuntime) {
    this.runtime = runtime;
  }

  async isEnabled(key: LifeOpsFeatureKey): Promise<boolean> {
    const state = await this.get(key);
    return state.enabled;
  }

  async get(key: LifeOpsFeatureKey): Promise<FeatureFlagState> {
    const sql = `SELECT ${SELECT_COLUMNS} FROM lifeops_features
      WHERE feature_key = ${sqlText(key)}
      LIMIT 1`;
    const rows = await executeRawSql(this.runtime, sql);
    if (rows.length === 0) {
      return defaultState(key);
    }
    return rowToState(rows[0], key);
  }

  async list(): Promise<ReadonlyArray<FeatureFlagState>> {
    const sql = `SELECT ${SELECT_COLUMNS} FROM lifeops_features`;
    const rows = await executeRawSql(this.runtime, sql);
    const byKey = new Map<LifeOpsFeatureKey, FeatureFlagState>();
    for (const row of rows) {
      const text = toText(row.feature_key);
      if (!isLifeOpsFeatureKey(text)) continue;
      byKey.set(text, rowToState(row, text));
    }
    return ALL_FEATURE_KEYS.map((key) => byKey.get(key) ?? defaultState(key));
  }

  enable(
    key: LifeOpsFeatureKey,
    source: FeatureFlagSource,
    enabledBy: string | null,
    metadata?: Readonly<Record<string, unknown>>,
  ): Promise<FeatureFlagState> {
    return this.upsert(key, true, source, enabledBy, metadata);
  }

  disable(
    key: LifeOpsFeatureKey,
    source: FeatureFlagSource,
    enabledBy: string | null,
  ): Promise<FeatureFlagState> {
    return this.upsert(key, false, source, enabledBy, undefined);
  }

  subscribeChanges(handler: FeatureFlagChangeListener): () => void {
    this.listeners.add(handler);
    return () => {
      this.listeners.delete(handler);
    };
  }

  private async upsert(
    key: LifeOpsFeatureKey,
    enabled: boolean,
    source: FeatureFlagSource,
    enabledBy: string | null,
    metadata: Readonly<Record<string, unknown>> | undefined,
  ): Promise<FeatureFlagState> {
    if (source === "default") {
      throw new Error(
        "[FeatureFlags] refusing to write a row with source='default'",
      );
    }
    const enabledAtSql = enabled
      ? `(${sqlText(new Date().toISOString())}::timestamptz)`
      : "NULL";
    const enabledBySql = enabledBy ? sqlText(enabledBy) : "NULL";
    const metadataSql = sqlJson(metadata ?? {});
    const sql = `INSERT INTO lifeops_features (
        feature_key, enabled, source, enabled_at, enabled_by, metadata, created_at, updated_at
      ) VALUES (
        ${sqlText(key)},
        ${sqlBoolean(enabled)},
        ${sqlText(source)},
        ${enabledAtSql},
        ${enabledBySql},
        ${metadataSql},
        now(),
        now()
      )
      ON CONFLICT (feature_key) DO UPDATE SET
        enabled = EXCLUDED.enabled,
        source = EXCLUDED.source,
        enabled_at = EXCLUDED.enabled_at,
        enabled_by = EXCLUDED.enabled_by,
        metadata = EXCLUDED.metadata,
        updated_at = now()
      RETURNING ${SELECT_COLUMNS}`;
    const rows = await executeRawSql(this.runtime, sql);
    if (rows.length === 0) {
      throw new Error(`[FeatureFlags] upsert returned no rows for ${key}`);
    }
    const state = rowToState(rows[0], key);
    logger.info(
      `[FeatureFlags] ${key} ${enabled ? "enabled" : "disabled"} via ${source}` +
        (enabledBy ? ` by ${enabledBy}` : ""),
    );
    for (const listener of this.listeners) {
      listener(state);
    }
    return state;
  }
}

const RUNTIME_CACHE = new WeakMap<IAgentRuntime, FeatureFlagService>();

/**
 * Cached factory — returns the same service instance per runtime so
 * `subscribeChanges` listeners stay attached across action invocations.
 */
export function createFeatureFlagService(
  runtime: IAgentRuntime,
): FeatureFlagService {
  const existing = RUNTIME_CACHE.get(runtime);
  if (existing) return existing;
  const service = new PgFeatureFlagService(runtime);
  RUNTIME_CACHE.set(runtime, service);
  return service;
}

/**
 * Convenience guard for action handlers. Throws `FeatureNotEnabledError`
 * when the feature is off.
 */
export async function requireFeatureEnabled(
  runtime: IAgentRuntime,
  key: LifeOpsFeatureKey,
): Promise<void> {
  const service = createFeatureFlagService(runtime);
  if (!(await service.isEnabled(key))) {
    const { FeatureNotEnabledError } = await import("./feature-flags.types.js");
    throw new FeatureNotEnabledError(key);
  }
}
